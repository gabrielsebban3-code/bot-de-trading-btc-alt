"""Resampling of closed candles to higher timeframes (rule 3).

* Buckets are aligned on UTC (weeks open on Monday 00:00 UTC).
* A higher-timeframe candle exists only when ALL its base candles exist: an incomplete candle
  (data gap, or the candle still in progress in live mode) is dropped, never extrapolated.
* ``close_time`` = open_time + tf: the first instant at which the candle may be used.
* ``contig`` = the previous candle of the same timeframe is directly adjacent (used for warm-up after gaps).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.timeutil import bucket_start, tf_ms

OHLCV = ["open", "high", "low", "close", "volume", "quote_volume"]


def resample(df: pd.DataFrame, base_tf: str, tf: str, now_ms: int | None = None) -> pd.DataFrame:
    """Aggregate ``base_tf`` candles (``open_time`` int64 ms) into ``tf`` candles.

    ``now_ms``: in live mode, candles whose close time is after ``now_ms`` are dropped as well.
    """
    step, base = tf_ms(tf), tf_ms(base_tf)
    if step % base:
        raise ValueError(f"{tf} is not a multiple of {base_tf}")
    cols = [c for c in OHLCV + ["trades", "taker_buy_quote"] if c in df.columns]
    if df.empty:
        out = pd.DataFrame({c: pd.Series(dtype="float64") for c in ["open_time"] + cols})
        out["open_time"] = out["open_time"].astype("int64")
    elif step == base:
        out = df[["open_time"] + cols].copy().reset_index(drop=True)
    else:
        ot = df["open_time"].to_numpy(dtype="int64")
        bucket = bucket_start(ot, tf)
        g = df.assign(_b=bucket).groupby("_b", sort=True)
        agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum",
               "quote_volume": "sum"}
        if "trades" in cols:
            agg["trades"] = "sum"
        if "taker_buy_quote" in cols:
            agg["taker_buy_quote"] = "sum"
        out = g.agg(agg)
        count = g["open_time"].count()
        first_ot = g["open_time"].min()
        complete = (count == step // base) & (first_ot == first_ot.index)
        out = out[complete.to_numpy()].reset_index().rename(columns={"_b": "open_time"})
        out["open_time"] = out["open_time"].astype("int64")
    out["close_time"] = out["open_time"] + step
    if now_ms is not None:
        out = out[out["close_time"] <= now_ms].reset_index(drop=True)
    ot = out["open_time"].to_numpy()
    contig = np.zeros(len(out), dtype=bool)
    if len(out) > 1:
        contig[1:] = (ot[1:] - ot[:-1]) == step
    out["contig"] = contig
    return out


def align_closed(target_close_ms: np.ndarray, source_close_ms: np.ndarray, values: np.ndarray) -> np.ndarray:
    """Value of the last ``source`` candle CLOSED at or before each target instant (multi-timeframe join).

    NaN when no source candle is closed yet. This is the only way the bot reads a higher timeframe.
    """
    target = np.asarray(target_close_ms, dtype="int64")
    src = np.asarray(source_close_ms, dtype="int64")
    vals = np.asarray(values, dtype="float64")
    idx = np.searchsorted(src, target, side="right") - 1
    out = np.full(len(target), np.nan)
    ok = idx >= 0
    out[ok] = vals[idx[ok]]
    return out


def find_gaps(open_ms: np.ndarray, tf: str) -> list[tuple[int, int, int]]:
    """(first missing open time, last missing open time, number of missing candles) between candles."""
    step = tf_ms(tf)
    ot = np.asarray(open_ms, dtype="int64")
    if len(ot) < 2:
        return []
    diff = np.diff(ot)
    return [(int(ot[i] + step), int(ot[i + 1] - step), int(diff[i] // step) - 1) for i in np.nonzero(diff != step)[0]]
