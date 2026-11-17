"""Volatility indicators: true range, ATR, Bollinger bands and width."""
from __future__ import annotations

import numpy as np

from ._core import as_f, rolling_incl, sma, wilder


def true_range(high, low, close) -> np.ndarray:
    """True range; index 0 is NaN (no previous close)."""
    high, low, close = as_f(high), as_f(low), as_f(close)
    tr = np.full(len(high), np.nan)
    if len(high) > 1:
        pc = close[:-1]
        tr[1:] = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - pc), np.abs(low[1:] - pc)))
    return tr


def atr(high, low, close, period: int = 14) -> np.ndarray:
    """Wilder ATR, first value at index ``period`` (mean of TR[1..period])."""
    return wilder(true_range(high, low, close), period, start=1)


def bollinger(close, period: int = 20, k: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(middle, upper, lower) with the population standard deviation of the last ``period`` closes."""
    close = as_f(close)
    mid = sma(close, period)
    sd = rolling_incl(close, period, "std")
    return mid, mid + k * sd, mid - k * sd


def bb_width(close, period: int = 20, k: float = 2.0) -> np.ndarray:
    mid, up, lo = bollinger(close, period, k)
    with np.errstate(divide="ignore", invalid="ignore"):
        return (up - lo) / mid


def realized_vol(close, period: int) -> np.ndarray:
    """Standard deviation of log returns over the last ``period`` candles (current included)."""
    close = as_f(close)
    r = np.full(len(close), np.nan)
    r[1:] = np.diff(np.log(close))
    return rolling_incl(r, period, "std")
