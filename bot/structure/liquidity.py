"""Liquidity levels and sweeps (Step 4, used by C5).

* Equal highs / lows: at least ``min_group`` confirmed pivots of the same kind whose prices are within
  ``tol`` (relative) of each other. The level is the most extreme pivot of the group. Known from the
  confirmation of the last pivot of the group.
* Previous day / week high and low: from COMPLETED daily / weekly candles only.
* Sweep: candle t trades beyond an INTACT level (no candle went beyond it after it became known) and
  CLOSES back inside ("clôture de réintégration"). A level is swept at most once.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

SWEEP_COLS = ["idx", "direction", "level", "source"]


def equal_levels(piv: pd.DataFrame, tol: float, lookback: int, min_group: int = 2) -> pd.DataFrame:
    """Candidate equal-high / equal-low levels with the index at which each becomes known.

    Returns columns: known_idx, kind (+1 highs, -1 lows), level.
    """
    rows = []
    for kind in (1, -1):
        p = piv[piv["kind"] == kind].sort_values(["confirm_idx", "idx"], kind="stable")
        idxs, confs, prices = p["idx"].to_numpy(), p["confirm_idx"].to_numpy(), p["price"].to_numpy()
        for j in range(len(p)):
            recent = (idxs[:j] >= idxs[j] - lookback)
            others = prices[:j][recent]
            if len(others) == 0:
                continue
            ref = np.maximum(np.abs(others), abs(prices[j]))
            close_ones = others[np.abs(others - prices[j]) / ref <= tol]
            if len(close_ones) + 1 >= min_group:
                group = np.append(close_ones, prices[j])
                rows.append((int(confs[j]), kind, float(group.max() if kind == 1 else group.min())))
    return pd.DataFrame(rows, columns=["known_idx", "kind", "level"])


def sweeps(high, low, close, levels: pd.DataFrame, source: str) -> pd.DataFrame:
    """Sweeps of ``levels`` (known_idx, kind, level). direction = -1 for a high swept (bearish), +1 for a low."""
    h, l, c = (np.asarray(x, dtype="float64") for x in (high, low, close))
    n = len(h)
    out = []
    for known, kind, lvl in zip(levels["known_idx"], levels["kind"], levels["level"]):
        start = int(known) + 1             # the level is usable from the candle after its confirmation
        if start >= n:
            continue
        if kind == 1:
            beyond = np.nonzero(h[start:] > lvl)[0]
            if len(beyond):
                t = start + beyond[0]
                if c[t] < lvl:              # first excursion closed back below: sweep
                    out.append((t, -1, float(lvl), source))
        else:
            beyond = np.nonzero(l[start:] < lvl)[0]
            if len(beyond):
                t = start + beyond[0]
                if c[t] > lvl:
                    out.append((t, 1, float(lvl), source))
    df = pd.DataFrame(out, columns=SWEEP_COLS)
    return df.sort_values("idx", kind="stable").drop_duplicates(["idx", "direction"]).reset_index(drop=True)


def period_levels(open_time, close_time_htf, high_htf, low_htf) -> pd.DataFrame:
    """Previous completed period high/low as levels known at the first candle after the period closed."""
    ot = np.asarray(open_time, dtype="int64")
    rows = []
    for ct, hh, ll in zip(close_time_htf, high_htf, low_htf):
        k = int(np.searchsorted(ot, ct, side="left"))   # first candle opening at or after the period close
        if k < len(ot):
            rows.append((k - 1, 1, float(hh)))        # known_idx = k - 1 so that usable from candle k
            rows.append((k - 1, -1, float(ll)))
    return pd.DataFrame(rows, columns=["known_idx", "kind", "level"])
