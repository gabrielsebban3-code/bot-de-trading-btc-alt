"""Zones: fair value gaps and order blocks (Step 3 C5, Step 4). Strict definitions, confirmation-dated.

* FVG (bullish) on candles (i-2, i-1, i): low[i] > high[i-2]. Zone = [high[i-2], low[i]].
  It exists only from the CLOSE of candle i (``confirm_idx = i``). Bearish: high[i] < low[i-2].
* Order block (bullish): the last bearish candle (close < open) before the displacement candle (i-1) of a
  bullish FVG, within ``lookback`` candles, AND the impulse breaks structure (a bullish BOS/CHoCH whose
  index is within [i-1, i-1 + bos_window]). Zone = [low, high] of that candle.
  ``confirm_idx`` = max(FVG confirmation, break index). Symmetric for bearish order blocks.
* A zone is invalidated when a candle closes beyond its far side (below the low of a bullish zone).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

ZONE_COLS = ["confirm_idx", "direction", "bottom", "top", "origin_idx", "kind"]


def fvgs(high, low) -> pd.DataFrame:
    h = np.asarray(high, dtype="float64")
    l = np.asarray(low, dtype="float64")
    rows = []
    for i in range(2, len(h)):
        if l[i] > h[i - 2]:
            rows.append((i, 1, float(h[i - 2]), float(l[i]), i - 1, "FVG"))
        elif h[i] < l[i - 2]:
            rows.append((i, -1, float(h[i]), float(l[i - 2]), i - 1, "FVG"))
    return pd.DataFrame(rows, columns=ZONE_COLS)


def order_blocks(open_, high, low, close, fvg: pd.DataFrame, events: pd.DataFrame,
                 lookback: int = 10, bos_window: int = 5) -> pd.DataFrame:
    o, h, l, c = (np.asarray(x, dtype="float64") for x in (open_, high, low, close))
    rows = []
    ev_idx = events["idx"].to_numpy() if len(events) else np.zeros(0, dtype="int64")
    ev_dir = events["direction"].to_numpy() if len(events) else np.zeros(0, dtype="int8")
    for conf, d, _, _, disp, _ in fvg.itertuples(index=False):
        # structure break by the impulse
        ok = (ev_dir == d) & (ev_idx >= disp) & (ev_idx <= disp + bos_window)
        if not ok.any():
            continue
        brk = int(ev_idx[ok].min())
        # last opposite candle before the displacement candle
        ob = -1
        for j in range(disp - 1, max(-1, disp - 1 - lookback), -1):
            if (d == 1 and c[j] < o[j]) or (d == -1 and c[j] > o[j]):
                ob = j
                break
        if ob < 0:
            continue
        rows.append((max(int(conf), brk), int(d), float(l[ob]), float(h[ob]), ob, "OB"))
    df = pd.DataFrame(rows, columns=ZONE_COLS)
    return df.drop_duplicates(["origin_idx", "direction"]).reset_index(drop=True)


def invalidation_idx(zone_dir: int, bottom: float, top: float, start: int, close) -> int:
    """First candle index >= start closing beyond the far side of the zone, or -1."""
    c = np.asarray(close, dtype="float64")[start:]
    hit = np.nonzero(c < bottom)[0] if zone_dir == 1 else np.nonzero(c > top)[0]
    return int(start + hit[0]) if len(hit) else -1
