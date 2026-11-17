"""Derivatives indicators: funding z-score, open-interest change and OI / price divergence."""
from __future__ import annotations

import numpy as np

from ._core import as_f


def funding_zscore(rates, window: int) -> np.ndarray:
    """(rate - mean of the ``window`` PREVIOUS settlements) / their sample std (ddof=1). NaN before."""
    r = as_f(rates)
    out = np.full(len(r), np.nan)
    if len(r) > window:
        win = np.lib.stride_tricks.sliding_window_view(r, window)[:-1]
        mu = win.mean(axis=1)
        sd = win.std(axis=1, ddof=1)
        with np.errstate(divide="ignore", invalid="ignore"):
            out[window:] = np.where(sd > 0, (r[window:] - mu) / sd, 0.0)
    return out


def oi_change(oi, period: int) -> np.ndarray:
    """oi[i] / oi[i - period] - 1."""
    x = as_f(oi)
    out = np.full(len(x), np.nan)
    if len(x) > period:
        with np.errstate(divide="ignore", invalid="ignore"):
            out[period:] = x[period:] / x[:-period] - 1.0
    return out


def oi_price_divergence(oi, close, period: int) -> np.ndarray:
    """+1 price up & OI down, -1 price down & OI down (deleveraging), 0 otherwise, over ``period`` candles."""
    d_oi = oi_change(oi, period)
    c = as_f(close)
    d_px = np.full(len(c), np.nan)
    if len(c) > period:
        d_px[period:] = c[period:] / c[:-period] - 1.0
    out = np.zeros(len(c), dtype="int8")
    with np.errstate(invalid="ignore"):
        out[(d_px > 0) & (d_oi < 0)] = 1
        out[(d_px < 0) & (d_oi < 0)] = -1
    return out
