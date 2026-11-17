"""Study 8 data: hourly perpetual klines for the 40 pairs of study 7 (data.binance.vision monthly archives)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pandas as pd

from . import data
from .etude7_data import OUT as D7, universe

OUT = data.ROOT / "data" / "etude8"


def one(sym: str, end_month: str = "2026-10") -> int:
    base = data.load_config()["data"]["archive_base"]
    n = 0
    for m in [str(p) for p in pd.period_range("2019-09", end_month, freq="M")]:
        if data.fetch_archive(f"{base}/monthly/klines/{sym}/1h/{sym}-1h-{m}.zip", OUT / "raw" / sym / f"{m}.zip"):
            n += 1
    files = sorted((OUT / "raw" / sym).glob("*.zip"))
    df = pd.concat([data.read_kline_zip(p) for p in files], ignore_index=True)
    df = df.drop_duplicates("open_time").sort_values("open_time")[["open_time", "open", "high", "low", "close"]]
    df.to_parquet(OUT / f"{sym}.parquet", index=False)
    return n


if __name__ == "__main__":
    u = universe()
    syms = u["in_sample"] + u["new"]
    OUT.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=12) as pool:
        for s, n in zip(syms, pool.map(one, syms)):
            print(s, n)
