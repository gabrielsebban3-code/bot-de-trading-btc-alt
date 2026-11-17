"""Study 7 data: daily perpetual klines, funding and daily spot klines from data.binance.vision archives."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import yaml

from . import data

ROOT = data.ROOT
OUT = ROOT / "data" / "etude7"
SPOT_BASE = "https://data.binance.vision/data/spot"


def universe() -> dict:
    cfg = yaml.safe_load((ROOT / "config" / "etude7.yaml").read_text())
    old = [p["symbol"] for p in json.loads((ROOT / "config" / "pairs.json").read_text())["pairs"]]
    return {"in_sample": old, "new": list(cfg["universe_new"])}


def spot_symbol(sym: str) -> str:
    for prefix in ("1000000", "1000"):
        if sym.startswith(prefix):
            return sym[len(prefix):]
    return sym


def _months(end_month: str) -> list[str]:
    return [str(p) for p in pd.period_range("2019-09", end_month, freq="M")]


def download_symbol(sym: str, end_month: str) -> dict:
    cfg = data.load_config()
    base = cfg["data"]["archive_base"]
    got = {"klines": 0, "funding": 0, "spot": 0}
    for m in _months(end_month):
        if data.fetch_archive(f"{base}/monthly/klines/{sym}/1d/{sym}-1d-{m}.zip", OUT / "raw" / "perp" / sym / f"{m}.zip"):
            got["klines"] += 1
        if data.fetch_archive(f"{base}/monthly/fundingRate/{sym}/{sym}-fundingRate-{m}.zip", OUT / "raw" / "funding" / sym / f"{m}.zip"):
            got["funding"] += 1
        sp = spot_symbol(sym)
        if data.fetch_archive(f"{SPOT_BASE}/monthly/klines/{sp}/1d/{sp}-1d-{m}.zip", OUT / "raw" / "spot" / sym / f"{m}.zip"):
            got["spot"] += 1
    return got


def _read_klines(folder) -> pd.DataFrame:
    files = sorted(folder.glob("*.zip"))
    if not files:
        return pd.DataFrame(columns=["day", "close", "quote_volume"])
    df = pd.concat([data.read_kline_zip(p) for p in files], ignore_index=True)
    t = df["open_time"].astype("int64")
    t = t.where(t < 10**14, t // 1000)                       # spot archives switched to microseconds in 2025
    df["day"] = pd.to_datetime(t, unit="ms", utc=True).dt.floor("D")
    return df.drop_duplicates("day").sort_values("day")[["day", "close", "quote_volume"]].reset_index(drop=True)


def build(end_month: str = "2026-10") -> dict:
    u = universe()
    syms = u["in_sample"] + u["new"]
    with ThreadPoolExecutor(max_workers=10) as pool:
        counts = dict(zip(syms, pool.map(lambda s: download_symbol(s, end_month), syms)))
    close, spot, fund = {}, {}, {}
    for s in syms:
        k = _read_klines(OUT / "raw" / "perp" / s)
        close[s] = k.set_index("day")["close"]
        sp = _read_klines(OUT / "raw" / "spot" / s)
        if len(sp):
            spot[s] = sp.set_index("day")["close"]
        files = sorted((OUT / "raw" / "funding" / s).glob("*.zip"))
        if files:
            f = pd.concat([data.read_funding_zip(p) for p in files], ignore_index=True)
            f["day"] = pd.to_datetime(f["funding_time"], unit="ms", utc=True).dt.floor("D")
            fund[s] = f.drop_duplicates("funding_time").groupby("day")["funding_rate"].sum()
    end = pd.Timestamp(end_month).to_period("M").end_time.floor("D").tz_localize("UTC")
    for name, d in (("perp_close", close), ("spot_close", spot), ("funding_daily", fund)):
        frame = pd.DataFrame(d).sort_index()
        frame = frame[frame.index <= end]
        frame.to_parquet(OUT / f"{name}.parquet")
    (OUT / "download_counts.json").write_text(json.dumps(counts, indent=1))
    return counts


if __name__ == "__main__":
    c = build()
    for s, v in c.items():
        print(s, v)
