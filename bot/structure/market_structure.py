"""Market structure from CONFIRMED pivots (Step 4): HH/HL/LH/LL labels, BOS, CHoCH, trend and range state.

All outputs at candle t use pivots confirmed at or before t and the close of candle t only.

* Label of a pivot (known at its confirmation): HH / LH for highs versus the previous confirmed high,
  HL / LL for lows versus the previous confirmed low.
* Break events: candle t CLOSES beyond the last confirmed swing level that is still unbroken.
  Upward break when the trend was down = bullish CHoCH; when it was up or unknown = bullish BOS
  (symmetric for downward breaks). Each swing level can be broken once.
* Trend: +1 after a bullish break, -1 after a bearish break, 0 before any break.
* Range: volatility compression = Bollinger width in the lowest ``bb_width_pct`` of the last
  ``bb_width_window`` candles AND ADX below ``adx_max``.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..indicators._core import rolling_rank_pct
from ..indicators.trend import adx
from ..indicators.volatility import bb_width

EVENT_COLS = ["idx", "kind", "direction", "level", "pivot_idx"]


def label_pivots(piv: pd.DataFrame) -> pd.Series:
    """'HH', 'LH', 'HL', 'LL' or '' (first pivot of its kind), in confirmation order."""
    labels = pd.Series("", index=piv.index, dtype="object")
    last = {1: np.nan, -1: np.nan}
    for j in piv.sort_values(["confirm_idx", "idx"], kind="stable").index:
        k = int(piv.at[j, "kind"])
        pr = float(piv.at[j, "price"])
        prev = last[k]
        if np.isfinite(prev):
            if k == 1:
                labels[j] = "HH" if pr > prev else "LH"
            else:
                labels[j] = "HL" if pr > prev else "LL"
        last[k] = pr
    return labels


def structure_events(close, piv: pd.DataFrame) -> tuple[pd.DataFrame, np.ndarray]:
    """(events, trend per candle). Events: idx, kind ('BOS'/'CHoCH'), direction (+1/-1), level, pivot_idx."""
    c = np.asarray(close, dtype="float64")
    n = len(c)
    by_conf: dict[int, list[tuple[int, float, int]]] = {}
    for i, cf, pr, k in zip(piv["idx"], piv["confirm_idx"], piv["price"], piv["kind"]):
        by_conf.setdefault(int(cf), []).append((int(k), float(pr), int(i)))
    swing = {1: None, -1: None}          # (price, pivot idx) of the last confirmed, still unbroken swing
    trend = 0
    trend_arr = np.zeros(n, dtype="int8")
    events = []
    for t in range(n):
        for k, pr, i in sorted(by_conf.get(t, []), key=lambda x: x[2]):
            swing[k] = (pr, i)             # a newer swing replaces the older one
        hi, lo = swing[1], swing[-1]
        if hi is not None and c[t] > hi[0]:
            events.append((t, "CHoCH" if trend == -1 else "BOS", 1, hi[0], hi[1]))
            trend, swing[1] = 1, None
        elif lo is not None and c[t] < lo[0]:
            events.append((t, "CHoCH" if trend == 1 else "BOS", -1, lo[0], lo[1]))
            trend, swing[-1] = -1, None
        trend_arr[t] = trend
    ev = pd.DataFrame(events, columns=EVENT_COLS)
    return ev.astype({"idx": "int64", "direction": "int8", "level": "float64", "pivot_idx": "int64"}), trend_arr


def range_state(high, low, close, cfg_range: dict, adx_period: int = 14, bb_period: int = 20) -> np.ndarray:
    """True where the market is in compression (range) at candle t."""
    w = bb_width(close, bb_period, 2.0)
    rank = rolling_rank_pct(w, int(cfg_range["bb_width_window"]))
    a = adx(high, low, close, adx_period)
    with np.errstate(invalid="ignore"):
        return (rank <= float(cfg_range["bb_width_pct"])) & (a < float(cfg_range["adx_max"]))


def trend_state(close, piv: pd.DataFrame, high, low, cfg_range: dict) -> np.ndarray:
    """+1 up, -1 down, 0 range or unknown."""
    _, tr = structure_events(close, piv)
    rng = range_state(high, low, close, cfg_range)
    out = tr.copy()
    out[rng] = 0
    return out
