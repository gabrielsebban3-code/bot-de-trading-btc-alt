"""Download, cleaning, quality checks and guarded loading of Binance USDT-M futures data.

All timestamps are UTC. Candles are identified by their open time.
The TEST set cannot be loaded unless ``final_test_unlocked: true`` is set in config.yaml.
"""
from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.dataset as pads
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "config.yaml"
PAIRS_PATH = ROOT / "config" / "pairs.json"
RAW_DIR = ROOT / "data" / "raw"
PARQUET_DIR = ROOT / "data" / "parquet"
RESULTS_DIR = ROOT / "results"

BAR_MS = 15 * 60 * 1000
TF_MS = {"15m": BAR_MS, "1h": 4 * BAR_MS, "4h": 16 * BAR_MS}

KLINE_COLS = ["open_time", "open", "high", "low", "close", "volume", "close_time",
              "quote_volume", "count", "taker_buy_volume", "taker_buy_quote_volume", "ignore"]


class TestSetLockedError(RuntimeError):
    """Raised when code tries to read TEST data while the lock is on."""


class DataUnavailableError(RuntimeError):
    """Raised when a required public file cannot be fetched."""


# ---------------------------------------------------------------- config

OVERLAY_PATH: Path | None = None        # follow-up study: yaml file whose top-level keys replace those of config.yaml


def load_config(path: Path | str | None = None) -> dict:
    with open(path or CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if path is None and OVERLAY_PATH is not None:
        with open(OVERLAY_PATH, "r", encoding="utf-8") as fh:
            cfg.update(yaml.safe_load(fh))
    return cfg


def to_ms(ts) -> int:
    """UTC date/time string or Timestamp -> epoch milliseconds."""
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return int(t.value // 1_000_000)


def ms_to_ts(ms) -> pd.Timestamp:
    return pd.Timestamp(int(ms), unit="ms", tz="UTC")


def data_end_ms(cfg: dict) -> int:
    """Exclusive end of the downloaded data (first ms after the last month)."""
    end = pd.Period(cfg["data"]["end_month"], freq="M") + 1
    return to_ms(end.start_time)


def set_bounds_ms(cfg: dict, set_name: str) -> tuple[int, int]:
    """[start, end) bounds of a set in epoch ms. Raises if TEST is requested while locked."""
    if set_name not in cfg["sets"]:
        raise KeyError(f"unknown set {set_name!r}")
    if set_name == "test" and not cfg.get("final_test_unlocked", False):
        raise TestSetLockedError(
            "TEST set is locked: set final_test_unlocked: true in config.yaml "
            "only after the mandatory stop (section 12).")
    spec = cfg["sets"][set_name]
    start = to_ms(spec["start"])
    if spec["end"] is None:
        end = data_end_ms(cfg)
    else:
        end = to_ms(pd.Timestamp(spec["end"]) + pd.Timedelta(days=1))
    return start, end


def max_readable_ms(cfg: dict) -> int:
    """Exclusive upper bound of what may be read from disk given the TEST lock."""
    if cfg.get("final_test_unlocked", False):
        return data_end_ms(cfg)
    return to_ms(cfg["sets"]["test"]["start"])


# ---------------------------------------------------------------- download

def _http_get(url: str, timeout: int = 60, retries: int = 4) -> requests.Response:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, timeout=timeout)
            if resp.status_code in (200, 404):
                return resp
            last = DataUnavailableError(f"HTTP {resp.status_code} for {url}: {resp.text[:200]}")
            if resp.status_code in (403, 407, 451):
                break  # policy / geo refusal: retrying is pointless
        except requests.RequestException as exc:  # network error
            last = exc
        time.sleep(2 ** attempt)
    raise DataUnavailableError(f"cannot fetch {url}: {last}")


def fetch_archive(url: str, dest: Path, verify_checksum: bool = True) -> bool:
    """Download one archive zip (with sha256 check). Returns False when the file does not exist."""
    if dest.exists() and dest.stat().st_size > 0:
        return True
    resp = _http_get(url)
    if resp.status_code == 404:
        return False
    content = resp.content
    if verify_checksum:
        chk = _http_get(url + ".CHECKSUM")
        if chk.status_code == 200:
            expected = chk.text.split()[0].strip()
            got = hashlib.sha256(content).hexdigest()
            if got != expected:
                raise DataUnavailableError(f"checksum mismatch for {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(content)
    tmp.rename(dest)
    return True


def month_list(start_ms: int, end_month: str) -> list[str]:
    first = ms_to_ts(start_ms).tz_localize(None).to_period("M")
    last = pd.Period(end_month, freq="M")
    return [str(p) for p in pd.period_range(first, last, freq="M")]


def _kline_url(cfg: dict, symbol: str, interval: str, month: str) -> str:
    return f"{cfg['data']['archive_base']}/monthly/klines/{symbol}/{interval}/{symbol}-{interval}-{month}.zip"


def _funding_url(cfg: dict, symbol: str, month: str) -> str:
    return f"{cfg['data']['archive_base']}/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{month}.zip"


def read_kline_zip(path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(path) as zf:
        raw = zf.read(zf.namelist()[0])
    has_header = raw[:9] == b"open_time"
    df = pd.read_csv(io.BytesIO(raw), header=0 if has_header else None, names=None if has_header else KLINE_COLS)
    df = df[["open_time", "open", "high", "low", "close", "volume", "quote_volume"]].copy()
    ot = df["open_time"].astype("int64")
    # futures archives are in ms; guard against a switch to microseconds
    df["open_time"] = np.where(ot > 10 ** 14, ot // 1000, ot)
    for col in ["open", "high", "low", "close", "volume", "quote_volume"]:
        df[col] = df[col].astype("float64")
    return df


def read_funding_zip(path: Path) -> pd.DataFrame:
    with zipfile.ZipFile(path) as zf:
        raw = zf.read(zf.namelist()[0])
    df = pd.read_csv(io.BytesIO(raw))
    out = pd.DataFrame({
        "funding_time": df["calc_time"].astype("int64"),
        "funding_rate": df["last_funding_rate"].astype("float64"),
    })
    return out


def symbol_start_ms(cfg: dict, onboard_ms: int) -> int:
    return max(to_ms(cfg["data"]["start"]), int(onboard_ms))


def download_symbol(cfg: dict, symbol: str, onboard_ms: int) -> dict:
    """Download every monthly 15m kline and funding archive of one symbol."""
    months = month_list(symbol_start_ms(cfg, onboard_ms), cfg["data"]["end_month"])
    missing_k, missing_f = [], []
    for month in months:
        kdest = RAW_DIR / "klines" / symbol / f"{symbol}-15m-{month}.zip"
        if not fetch_archive(_kline_url(cfg, symbol, "15m", month), kdest):
            missing_k.append(month)
        fdest = RAW_DIR / "funding" / symbol / f"{symbol}-fundingRate-{month}.zip"
        if not fetch_archive(_funding_url(cfg, symbol, month), fdest):
            missing_f.append(month)
    return {"symbol": symbol, "months": len(months), "missing_kline_months": missing_k,
            "missing_funding_months": missing_f}


def build_parquet(cfg: dict, symbol: str) -> dict:
    """Concatenate raw archives into one cleaned parquet table per symbol (klines + funding).

    Cleaning = sort + drop exact duplicate open times (first kept). Nothing is filled or interpolated.
    """
    kfiles = sorted((RAW_DIR / "klines" / symbol).glob("*.zip"))
    if not kfiles:
        raise DataUnavailableError(f"no kline archive on disk for {symbol}")
    df = pd.concat([read_kline_zip(p) for p in kfiles], ignore_index=True)
    n_raw = len(df)
    df = df.sort_values("open_time", kind="stable")
    n_dup = int(df["open_time"].duplicated().sum())
    df = df.drop_duplicates("open_time", keep="first").reset_index(drop=True)
    n_misaligned = int((df["open_time"] % BAR_MS != 0).sum())
    df = df[df["open_time"] % BAR_MS == 0].reset_index(drop=True)
    df = df[(df["open_time"] >= to_ms(cfg["data"]["start"])) & (df["open_time"] < data_end_ms(cfg))]
    df = df.reset_index(drop=True)
    out = df.copy()
    out["open_time"] = pd.to_datetime(out["open_time"], unit="ms", utc=True)
    (PARQUET_DIR / "klines").mkdir(parents=True, exist_ok=True)
    out.to_parquet(PARQUET_DIR / "klines" / f"{symbol}.parquet", index=False)

    ffiles = sorted((RAW_DIR / "funding" / symbol).glob("*.zip"))
    if ffiles:
        fd = pd.concat([read_funding_zip(p) for p in ffiles], ignore_index=True)
    else:
        fd = pd.DataFrame({"funding_time": pd.Series(dtype="int64"), "funding_rate": pd.Series(dtype="float64")})
    fd = fd.sort_values("funding_time", kind="stable").drop_duplicates("funding_time", keep="first")
    fd = fd[fd["funding_time"] < data_end_ms(cfg)].reset_index(drop=True)
    fout = fd.copy()
    fout["funding_time"] = pd.to_datetime(fout["funding_time"], unit="ms", utc=True)
    (PARQUET_DIR / "funding").mkdir(parents=True, exist_ok=True)
    fout.to_parquet(PARQUET_DIR / "funding" / f"{symbol}.parquet", index=False)
    return {"symbol": symbol, "raw_rows": n_raw, "duplicates": n_dup, "misaligned": n_misaligned,
            "rows": len(df), "funding_rows": len(fd)}


# ---------------------------------------------------------------- pair selection

def load_exchange_info(path: Path) -> list[dict]:
    with open(path, "r", encoding="utf-8") as fh:
        info = json.load(fh)
    return info["symbols"]


def candidate_symbols(cfg: dict, symbols: list[dict]) -> tuple[list[dict], dict]:
    """Apply the filters of section 3.2 (steps 1-2) to exchangeInfo."""
    sel = cfg["data"]["pair_selection"]
    as_of = pd.Timestamp(sel["as_of"], tz="UTC")
    cutoff_ms = to_ms(as_of - pd.DateOffset(months=sel["min_listing_months"]))
    stable = set(sel["stablecoin_bases"])
    kept, dropped = [], {"not_usdt_perp_trading": 0, "stablecoin": [], "index": [], "too_recent": []}
    for s in symbols:
        if not (s.get("contractType") == "PERPETUAL" and s.get("status") == "TRADING"
                and s.get("quoteAsset") == "USDT" and s.get("marginAsset", "USDT") == "USDT"):
            dropped["not_usdt_perp_trading"] += 1
            continue
        name, base = s["symbol"], s.get("baseAsset", "")
        if base in stable:
            dropped["stablecoin"].append(name)
            continue
        if s.get("underlyingType", "COIN") != "COIN" or base.endswith("DOM") or base in ("DEFI", "ALL"):
            dropped["index"].append(name)
            continue
        if int(s["onboardDate"]) > cutoff_ms:
            dropped["too_recent"].append(name)
            continue
        kept.append({"symbol": name, "baseAsset": base, "onboardDate": int(s["onboardDate"])})
    return kept, dropped


def _daily_quote_volume(cfg: dict, symbol: str, days: pd.DatetimeIndex) -> float:
    """Average daily quote volume (USDT) over ``days`` from 1d archive klines."""
    base = cfg["data"]["archive_base"]
    end_month = pd.Period(cfg["data"]["end_month"], freq="M")
    frames = []
    months = sorted({d.to_period("M") for d in days.tz_localize(None)})
    for month in months:
        if month <= end_month:
            dest = RAW_DIR / "klines_1d" / symbol / f"{symbol}-1d-{month}.zip"
            url = f"{base}/monthly/klines/{symbol}/1d/{symbol}-1d-{month}.zip"
            if fetch_archive(url, dest, verify_checksum=False):
                frames.append(read_kline_zip(dest))
        else:
            for d in days[days.tz_localize(None).to_period("M") == month]:
                ds = d.strftime("%Y-%m-%d")
                dest = RAW_DIR / "klines_1d" / symbol / f"{symbol}-1d-{ds}.zip"
                url = f"{base}/daily/klines/{symbol}/1d/{symbol}-1d-{ds}.zip"
                if fetch_archive(url, dest, verify_checksum=False):
                    frames.append(read_kline_zip(dest))
    if not frames:
        return float("nan")
    df = pd.concat(frames, ignore_index=True).drop_duplicates("open_time")
    wanted = {to_ms(d) for d in days}
    df = df[df["open_time"].isin(wanted)]
    if len(df) < 0.9 * len(days):
        return float("nan")  # not enough daily candles to rank
    return float(df["quote_volume"].sum() / len(days))


def select_pairs(cfg: dict, exchange_info_path: Path, workers: int = 16) -> dict:
    """Section 3.2: build config/pairs.json once. Refuses to overwrite an existing list."""
    if PAIRS_PATH.exists():
        raise RuntimeError("config/pairs.json already exists: the pair list is frozen.")
    sel = cfg["data"]["pair_selection"]
    kept, dropped = candidate_symbols(cfg, load_exchange_info(exchange_info_path))
    as_of = pd.Timestamp(sel["as_of"], tz="UTC")
    days = pd.date_range(as_of - pd.Timedelta(days=sel["volume_window_days"]),
                         as_of - pd.Timedelta(days=1), freq="D")
    with ThreadPoolExecutor(max_workers=workers) as pool:
        vols = list(pool.map(lambda s: _daily_quote_volume(cfg, s["symbol"], days), kept))
    for s, v in zip(kept, vols):
        s["avg_daily_quote_volume_90d"] = v
    ranked = sorted([s for s in kept if np.isfinite(s["avg_daily_quote_volume_90d"])],
                    key=lambda s: (-s["avg_daily_quote_volume_90d"], s["symbol"]))
    top = ranked[: sel["n_pairs"]]
    payload = {
        "selected_on": sel["as_of"],
        "volume_window": [str(days[0].date()), str(days[-1].date())],
        "n_candidates": len(kept),
        "n_without_volume_data": len(kept) - len(ranked),
        "pairs": [{"symbol": s["symbol"], "onboardDate": s["onboardDate"],
                   "onboardDateUTC": str(ms_to_ts(s["onboardDate"])),
                   "avg_daily_quote_volume_90d": round(s["avg_daily_quote_volume_90d"], 2)} for s in top],
    }
    PAIRS_PATH.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    payload["dropped"] = dropped
    payload["ranking"] = ranked
    return payload


def load_pairs() -> list[dict]:
    with open(PAIRS_PATH, "r", encoding="utf-8") as fh:
        return json.load(fh)["pairs"]


# ---------------------------------------------------------------- guarded loading

def load_klines(cfg: dict, symbol: str, end_ms: int | None = None) -> pd.DataFrame:
    """Load cleaned 15m candles with ``open_time`` as epoch ms (int64).

    Rows of the TEST set are never read while the lock is on.
    """
    limit = max_readable_ms(cfg)
    if end_ms is not None:
        if end_ms > limit:
            raise TestSetLockedError("requested data beyond the readable limit (TEST set locked)")
        limit = end_ms
    ds = pads.dataset(PARQUET_DIR / "klines" / f"{symbol}.parquet", format="parquet")
    tbl = ds.to_table(filter=pads.field("open_time") < pd.Timestamp(limit, unit="ms", tz="UTC"))
    df = tbl.to_pandas()
    df["open_time"] = df["open_time"].dt.as_unit("ms").astype("int64")
    return df.reset_index(drop=True)


def load_funding(cfg: dict, symbol: str, end_ms: int | None = None) -> pd.DataFrame:
    limit = max_readable_ms(cfg)
    if end_ms is not None:
        if end_ms > limit:
            raise TestSetLockedError("requested data beyond the readable limit (TEST set locked)")
        limit = end_ms
    ds = pads.dataset(PARQUET_DIR / "funding" / f"{symbol}.parquet", format="parquet")
    tbl = ds.to_table(filter=pads.field("funding_time") < pd.Timestamp(limit, unit="ms", tz="UTC"))
    df = tbl.to_pandas()
    df["funding_time"] = df["funding_time"].dt.as_unit("ms").astype("int64")
    return df.reset_index(drop=True)


# ---------------------------------------------------------------- resampling

def resample(df15: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Aggregate 15m candles into ``tf`` candles (epoch-aligned).

    A higher-timeframe candle exists only if all of its 15m candles exist (no partial candle).
    Adds ``close_time`` (ms, exclusive end = first instant the candle is usable) and
    ``contig`` (True when the previous candle of the same timeframe is directly adjacent).
    """
    step = TF_MS[tf]
    if tf == "15m":
        out = df15[["open_time", "open", "high", "low", "close", "volume", "quote_volume"]].copy()
    else:
        bucket = (df15["open_time"].to_numpy() // step) * step
        g = df15.groupby(bucket, sort=True)
        out = pd.DataFrame({
            "open_time": g["open_time"].first().index.to_numpy(),
            "open": g["open"].first().to_numpy(),
            "high": g["high"].max().to_numpy(),
            "low": g["low"].min().to_numpy(),
            "close": g["close"].last().to_numpy(),
            "volume": g["volume"].sum().to_numpy(),
            "quote_volume": g["quote_volume"].sum().to_numpy(),
        })
        complete = g["open_time"].count().to_numpy() == step // BAR_MS
        out = out[complete].reset_index(drop=True)
    out["close_time"] = out["open_time"] + step
    ot = out["open_time"].to_numpy()
    contig = np.zeros(len(out), dtype=bool)
    if len(out) > 1:
        contig[1:] = (ot[1:] - ot[:-1]) == step
    out["contig"] = contig
    return out


def align_htf(base_close_ms: np.ndarray, htf_close_ms: np.ndarray, htf_values: np.ndarray) -> np.ndarray:
    """Value of the last higher-timeframe candle CLOSED at or before each base candle close.

    Equivalent to ``merge_asof`` on close timestamps (direction backward). NaN when none is closed yet.
    """
    left = pd.DataFrame({"t": np.asarray(base_close_ms, dtype="int64")})
    right = pd.DataFrame({"t": np.asarray(htf_close_ms, dtype="int64"), "v": np.asarray(htf_values, dtype="float64")})
    merged = pd.merge_asof(left, right, on="t", direction="backward")
    return merged["v"].to_numpy()


# ---------------------------------------------------------------- quality checks

def find_gaps(open_ms: np.ndarray) -> list[tuple[int, int, int]]:
    """List of (first_missing_ms, last_missing_ms, n_missing) between consecutive candles."""
    gaps = []
    if len(open_ms) < 2:
        return gaps
    diff = np.diff(open_ms)
    for i in np.nonzero(diff != BAR_MS)[0]:
        n = int(diff[i] // BAR_MS) - 1
        gaps.append((int(open_ms[i] + BAR_MS), int(open_ms[i + 1] - BAR_MS), n))
    return gaps


def quality_stats(cfg: dict, symbol: str, onboard_ms: int, build_info: dict | None = None) -> dict:
    """Quality statistics on the readable range (TEST rows excluded while locked)."""
    df = load_klines(cfg, symbol)
    limit = max_readable_ms(cfg)
    ot = df["open_time"].to_numpy()
    start = int(ot[0]) if len(ot) else symbol_start_ms(cfg, onboard_ms)
    expected_from_listing = max(0, (limit - max(symbol_start_ms(cfg, onboard_ms), start)) // BAR_MS)
    expected = int((limit - start) // BAR_MS) if len(ot) else int(expected_from_listing)
    gaps = find_gaps(ot)
    tail_missing = int((limit - (ot[-1] + BAR_MS)) // BAR_MS) if len(ot) else 0
    if tail_missing > 0:
        gaps.append((int(ot[-1] + BAR_MS), int(limit - BAR_MS), tail_missing))
    missing = sum(g[2] for g in gaps)
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    bad_hl = int((h < l).sum())
    bad_close = int(((c < l) | (c > h)).sum())
    bad_open = int(((o < l) | (o > h)).sum())
    move = np.abs(c / o - 1.0) * 100.0
    rng = (h / l - 1.0) * 100.0
    big = np.nonzero((move > cfg["data"]["big_move_pct"]) | (rng > cfg["data"]["big_move_pct"]))[0]
    big_list = [(str(ms_to_ts(ot[i])), round(float(move[i]), 2), round(float(rng[i]), 2)) for i in big]
    return {
        "symbol": symbol,
        "first_candle": str(ms_to_ts(start)) if len(ot) else None,
        "last_candle": str(ms_to_ts(ot[-1])) if len(ot) else None,
        "expected": expected,
        "received": int(len(ot)),
        "missing": int(missing),
        "missing_pct": round(100.0 * missing / expected, 4) if expected else float("nan"),
        "gaps": [(str(ms_to_ts(a)), str(ms_to_ts(b)), n) for a, b, n in gaps],
        "duplicates_removed": (build_info or {}).get("duplicates"),
        "zero_volume": int((df["volume"].to_numpy() == 0).sum()),
        "high_lt_low": bad_hl,
        "close_outside_range": bad_close,
        "open_outside_range": bad_open,
        "big_moves": big_list,
        "funding_rows": int(len(load_funding(cfg, symbol))),
    }
