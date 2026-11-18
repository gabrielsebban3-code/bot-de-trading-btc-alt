"""Public data sources. No API key, no order endpoint (rule 5).

* ``ArchiveClient``: monthly / daily archives of https://data.binance.vision (history, delisted pairs included).
* ``LiveClient``: REST klines through ccxt (``binanceusdm``), closed candles only, for the live scanner.

``fapi.binance.com`` answers HTTP 451 from some locations (US servers, including GitHub-hosted runners and
the research server). The archives are not affected. See README "Limites".
"""
from __future__ import annotations

import hashlib
import io
import re
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable, Iterable

import numpy as np
import pandas as pd
import requests

from ..core.logs import get_logger
from ..core.timeutil import month_end_ms, tf_ms
from .storage import MarketStore

log = get_logger(__name__)

KLINE_COLS = ["open_time", "open", "high", "low", "close", "volume", "close_time", "quote_volume", "trades",
              "taker_buy_volume", "taker_buy_quote", "ignore"]
_S3_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"


class DataUnavailableError(RuntimeError):
    pass


@dataclass
class Http:
    timeout: int = 60
    retries: int = 4

    def __post_init__(self) -> None:
        self._local = threading.local()

    def _session(self) -> requests.Session:
        if not hasattr(self._local, "s"):
            self._local.s = requests.Session()
        return self._local.s

    def get(self, url: str, params: dict | None = None) -> requests.Response:
        last: Exception | None = None
        for attempt in range(self.retries):
            try:
                resp = self._session().get(url, params=params, timeout=self.timeout)
                if resp.status_code in (200, 404):
                    return resp
                last = DataUnavailableError(f"HTTP {resp.status_code} for {url}: {resp.text[:200]}")
                if resp.status_code in (403, 407, 451):
                    break  # policy or geographic refusal: retrying is pointless
                if resp.status_code == 429:
                    time.sleep(10 * (attempt + 1))
            except requests.RequestException as exc:
                last = exc
            time.sleep(2 ** attempt)
        raise DataUnavailableError(f"cannot fetch {url}: {last}")


# ---------------------------------------------------------------- parsing

def _read_zip_csv(content: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        return zf.read(zf.namelist()[0])


def parse_klines(raw: bytes) -> pd.DataFrame:
    """Binance kline CSV (with or without header) -> DataFrame with int64 ms ``open_time``."""
    has_header = raw[:9] == b"open_time"
    df = pd.read_csv(io.BytesIO(raw), header=0 if has_header else None, names=None if has_header else KLINE_COLS)
    df.columns = KLINE_COLS[: len(df.columns)] if not has_header else [
        {"count": "trades", "taker_buy_quote_volume": "taker_buy_quote"}.get(c, c) for c in df.columns]
    ot = df["open_time"].astype("int64").to_numpy()
    ot = np.where(ot > 10 ** 14, ot // 1000, ot)        # guard against a switch to microseconds
    out = pd.DataFrame({"open_time": ot.astype("int64")})
    for c in ("open", "high", "low", "close", "volume", "quote_volume", "taker_buy_quote"):
        out[c] = df[c].astype("float64").to_numpy()
    out["trades"] = df["trades"].astype("int64").to_numpy()
    return out


def parse_funding(raw: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw))
    return pd.DataFrame({"time": df["calc_time"].astype("int64"), "rate": df["last_funding_rate"].astype("float64")})


def parse_metrics(raw: bytes) -> pd.DataFrame:
    """``metrics`` daily file (5-minute open interest) -> time (ms), oi (contracts), oi_value (USDT)."""
    df = pd.read_csv(io.BytesIO(raw))
    t = pd.to_datetime(df["create_time"], utc=True)
    return pd.DataFrame({"time": (t.astype("int64") // 1_000_000).astype("int64"),
                         "oi": df["sum_open_interest"].astype("float64"),
                         "oi_value": df["sum_open_interest_value"].astype("float64")})


# ---------------------------------------------------------------- archives

class ArchiveClient:
    def __init__(self, cfg: dict):
        d = cfg["data"]
        self.base = d["archive_base"].rstrip("/")
        self.listing = d["listing_base"].rstrip("/")
        self.verify = bool(d.get("verify_checksum", True))
        self.workers = int(d.get("download_workers", 8))
        self.http = Http(int(d.get("http_timeout_s", 60)), int(d.get("http_retries", 4)))
        self.prefix_root = "data/futures/um"

    # -------------------------------------------------------- listing (S3, paginated)
    def list_prefix(self, prefix: str, delimiter: bool = True) -> tuple[list[str], list[str]]:
        """(sub-prefixes, keys) under ``prefix``."""
        prefixes, keys, marker = [], [], ""
        while True:
            params = {"prefix": prefix, "marker": marker}
            if delimiter:
                params["delimiter"] = "/"
            resp = self.http.get(self.listing, params=params)
            if resp.status_code != 200:
                raise DataUnavailableError(f"listing failed for {prefix}: HTTP {resp.status_code}")
            root = ET.fromstring(resp.content)
            page_p = [e.text for e in root.iter(f"{_S3_NS}Prefix") if e.text and e.text != prefix]
            page_k = [e.text for e in root.iter(f"{_S3_NS}Key") if e.text]
            prefixes += page_p
            keys += page_k
            truncated = (root.findtext(f"{_S3_NS}IsTruncated") or "false") == "true"
            if not truncated:
                break
            nxt = root.findtext(f"{_S3_NS}NextMarker")
            marker = nxt or (page_k[-1] if page_k else page_p[-1])
        return prefixes, keys

    def symbols(self) -> list[str]:
        """Every symbol that ever had USDT-M monthly klines (delisted ones included)."""
        prefixes, _ = self.list_prefix(f"{self.prefix_root}/monthly/klines/")
        return sorted(p.rstrip("/").rsplit("/", 1)[-1] for p in prefixes)

    def periods(self, kind: str, symbol: str, tf: str | None = None, freq: str = "monthly") -> list[str]:
        """Available periods ('2024-05' or '2024-05-17') for one dataset of one symbol."""
        sub = f"{kind}/{symbol}/" + (f"{tf}/" if tf else "")
        _, keys = self.list_prefix(f"{self.prefix_root}/{freq}/{sub}", delimiter=False)
        pat = re.compile(r"-(\d{4}-\d{2}(?:-\d{2})?)\.zip$")
        return sorted({m.group(1) for k in keys if (m := pat.search(k))})

    def url(self, kind: str, symbol: str, period: str, tf: str | None = None, freq: str = "monthly") -> str:
        if kind == "klines":
            return f"{self.base}/{freq}/klines/{symbol}/{tf}/{symbol}-{tf}-{period}.zip"
        if kind == "fundingRate":
            return f"{self.base}/{freq}/fundingRate/{symbol}/{symbol}-fundingRate-{period}.zip"
        if kind == "metrics":
            return f"{self.base}/daily/metrics/{symbol}/{symbol}-metrics-{period}.zip"
        raise ValueError(kind)

    def fetch(self, url: str) -> tuple[bytes | None, str | None]:
        """(csv bytes, sha256 of the zip) or (None, None) when the archive does not exist."""
        resp = self.http.get(url)
        if resp.status_code == 404:
            return None, None
        content = resp.content
        digest = hashlib.sha256(content).hexdigest()
        if self.verify:
            chk = self.http.get(url + ".CHECKSUM")
            if chk.status_code == 200:
                expected = chk.text.split()[0].strip()
                if expected != digest:
                    raise DataUnavailableError(f"checksum mismatch for {url}")
        return _read_zip_csv(content), digest

    # -------------------------------------------------------- bulk ingestion
    def ingest(self, store: MarketStore, jobs: list[tuple[str, str, str, str, str | None, str]],
               parser: Callable[[bytes], pd.DataFrame], writer: Callable[[str, str | None, pd.DataFrame], int],
               progress_every: int = 200) -> dict:
        """Download and store ``jobs`` = [(url, kind, symbol, period, tf, freq)] in parallel.

        Files already recorded in the ``files`` table are skipped (idempotent, resumable).
        Writes happen in the calling thread (SQLite single writer).
        """
        todo = [j for j in jobs if not store.file_done(j[0])]
        stats = {"jobs": len(jobs), "skipped": len(jobs) - len(todo), "ok": 0, "missing": 0, "rows": 0, "errors": 0}
        if not todo:
            return stats

        def _work(job):
            url = job[0]
            raw, digest = self.fetch(url)
            return job, (None if raw is None else parser(raw)), digest

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            futures = [pool.submit(_work, j) for j in todo]
            for i, fut in enumerate(as_completed(futures), 1):
                try:
                    job, df, digest = fut.result()
                except Exception as exc:  # recorded and reported, never silently dropped
                    stats["errors"] += 1
                    log.error("download failed", error=str(exc))
                    continue
                url, kind, symbol, period, tf, _ = job
                if df is None:
                    store.record_file(url, kind, symbol, period, "missing")
                    stats["missing"] += 1
                else:
                    n = writer(symbol, tf, df)
                    store.record_file(url, kind, symbol, period, "ok", digest, n)
                    stats["ok"] += 1
                    stats["rows"] += n
                if i % progress_every == 0:
                    log.info("ingest progress", done=i, total=len(todo))
        return stats


def kline_jobs(client: ArchiveClient, symbol: str, tf: str, months: Iterable[str]) -> list[tuple]:
    return [(client.url("klines", symbol, m, tf), f"klines_{tf}", symbol, m, tf, "monthly") for m in months]


def funding_jobs(client: ArchiveClient, symbol: str, months: Iterable[str]) -> list[tuple]:
    return [(client.url("fundingRate", symbol, m), "funding", symbol, m, None, "monthly") for m in months]


def metrics_jobs(client: ArchiveClient, symbol: str, days: Iterable[str]) -> list[tuple]:
    return [(client.url("metrics", symbol, d), "metrics", symbol, d, None, "daily") for d in days]


# ---------------------------------------------------------------- live REST (closed candles only)

class LiveClient:
    """Closed candles and derivatives data from the public REST API through ccxt. No API key, no order."""

    def __init__(self, exchange=None):
        if exchange is None:
            import ccxt  # imported lazily: the backtest does not need it
            exchange = ccxt.binanceusdm({"enableRateLimit": True})
        self.ex = exchange
        self._ids: dict[str, str] | None = None

    def _sym(self, symbol: str) -> str:
        """Binance id (BTCUSDT) -> ccxt unified symbol (BTC/USDT:USDT)."""
        if self._ids is None:
            self.ex.load_markets()
            self._ids = {m["id"]: m["symbol"] for m in self.ex.markets.values()}
        return self._ids.get(symbol, symbol)

    def usdt_perpetuals(self) -> list[str]:
        self.ex.load_markets()
        return sorted(m["id"] for m in self.ex.markets.values()
                      if m.get("swap") and m.get("linear") and m.get("quote") == "USDT" and m.get("active", True))

    def quote_volume_24h(self, symbols: list[str]) -> dict[str, float]:
        t = self.ex.fetch_tickers()
        out = {}
        for sym in symbols:
            x = t.get(self._sym(sym))
            if x and x.get("quoteVolume"):
                out[sym] = float(x["quoteVolume"])
        return out

    @staticmethod
    def closed_only(rows: list[list], tf: str, now_ms: int) -> list[list]:
        """Drop the candle still in progress (rule 3): keep rows with open_time + tf <= now."""
        step = tf_ms(tf)
        return [r for r in rows if int(r[0]) + step <= now_ms]

    def fetch_closed(self, symbol: str, tf: str, since_ms: int, now_ms: int | None = None,
                     limit: int = 1500) -> pd.DataFrame:
        """Every closed candle from ``since_ms`` (gap fill: call with the last stored open time + tf)."""
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        market = self._sym(symbol)
        out: list[list] = []
        cursor = since_ms
        while cursor < now_ms:
            rows = self.ex.fetch_ohlcv(market, timeframe=tf, since=cursor, limit=limit)
            rows = self.closed_only(rows or [], tf, now_ms)
            if not rows:
                break
            out += rows
            nxt = int(rows[-1][0]) + tf_ms(tf)
            if nxt <= cursor:
                break
            cursor = nxt
        df = pd.DataFrame(out, columns=["open_time", "open", "high", "low", "close", "volume"])
        df = df.drop_duplicates("open_time").sort_values("open_time").reset_index(drop=True)
        df["open_time"] = df["open_time"].astype("int64")
        df["quote_volume"] = df["volume"] * df["close"]        # approximation: ccxt does not return it
        df["trades"] = pd.NA
        df["taker_buy_quote"] = np.nan
        return df

    def fetch_funding(self, symbol: str, since_ms: int) -> pd.DataFrame:
        rows = self.ex.fetch_funding_rate_history(self._sym(symbol), since=since_ms, limit=1000) or []
        return pd.DataFrame({"time": [int(r["timestamp"]) for r in rows], "rate": [float(r["fundingRate"]) for r in rows]})

    def fetch_open_interest(self, symbol: str, since_ms: int) -> pd.DataFrame:
        rows = self.ex.fetch_open_interest_history(self._sym(symbol), timeframe="1h", since=since_ms, limit=500) or []
        return pd.DataFrame({"time": [int(r["timestamp"]) for r in rows],
                             "oi": [float(r.get("openInterestAmount") or np.nan) for r in rows],
                             "oi_value": [float(r.get("openInterestValue") or np.nan) for r in rows]})


def month_range_closed(months: list[str], last_month: str) -> list[str]:
    """Months up to ``last_month`` included (never a month of the locked period)."""
    end = month_end_ms(last_month)
    return [m for m in months if month_end_ms(m) <= end]
