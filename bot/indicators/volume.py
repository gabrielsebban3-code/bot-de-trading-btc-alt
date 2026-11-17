"""Volume indicators: relative volume, session VWAP."""
from __future__ import annotations

import numpy as np

from ..core.timeutil import bucket_start
from ._core import as_f, rolling_prev


def relative_volume(volume, window: int = 20) -> np.ndarray:
    """volume[i] / mean(volume of the ``window`` previous candles)."""
    v = as_f(volume)
    with np.errstate(divide="ignore", invalid="ignore"):
        return v / rolling_prev(v, window, "mean")


def session_vwap(open_time, high, low, close, volume, anchor: str = "1d") -> np.ndarray:
    """VWAP of typical price, reset at each ``anchor`` boundary (UTC). Uses candles closed so far."""
    ot = np.asarray(open_time, dtype="int64")
    tp = (as_f(high) + as_f(low) + as_f(close)) / 3.0
    v = as_f(volume)
    session = bucket_start(ot, anchor)
    out = np.empty(len(ot))
    pv = vv = 0.0
    cur = None
    for i in range(len(ot)):
        if session[i] != cur:
            cur, pv, vv = session[i], 0.0, 0.0
        pv += tp[i] * v[i]
        vv += v[i]
        out[i] = pv / vv if vv > 0 else tp[i]
    return out
