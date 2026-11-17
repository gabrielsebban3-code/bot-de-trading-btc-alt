"""Trend indicators: EMA, ADX, Donchian channels, regime helpers."""
from __future__ import annotations

import numpy as np

from ._core import as_f, rolling_prev, sma, wilder
from .volatility import true_range

__all__ = ["sma", "ema", "adx", "donchian", "ema_regime"]


def ema(x, period: int) -> np.ndarray:
    """EMA seeded with the simple mean of the first ``period`` values, alpha = 2/(period+1). NaN before.

    NaN inputs after the seed are not allowed (callers pass complete series).
    """
    x = as_f(x)
    n = len(x)
    out = np.full(n, np.nan)
    if n < period:
        return out
    alpha = 2.0 / (period + 1.0)
    prev = float(x[:period].mean())
    out[period - 1] = prev
    for i in range(period, n):
        prev = prev + alpha * (x[i] - prev)
        out[i] = prev
    return out


def adx(high, low, close, period: int = 14) -> np.ndarray:
    """Wilder ADX, first value at index 2*period - 1."""
    high, low, close = as_f(high), as_f(low), as_f(close)
    n = len(high)
    out = np.full(n, np.nan)
    if n < 2 * period:
        return out
    up = np.zeros(n)
    dn = np.zeros(n)
    up[1:] = high[1:] - high[:-1]
    dn[1:] = low[:-1] - low[1:]
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr_s = wilder(true_range(high, low, close), period, start=1)
    pdm_s = wilder(plus_dm, period, start=1)
    mdm_s = wilder(minus_dm, period, start=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100.0 * pdm_s / tr_s
        mdi = 100.0 * mdm_s / tr_s
        denom = pdi + mdi
        dx = np.where(denom > 0, 100.0 * np.abs(pdi - mdi) / denom, 0.0)
    dx[np.isnan(tr_s)] = np.nan
    return wilder(dx, period, start=period)


def donchian(high, low, period: int) -> tuple[np.ndarray, np.ndarray]:
    """(highest high, lowest low) of the ``period`` candles BEFORE the current one."""
    return rolling_prev(high, period, "max"), rolling_prev(low, period, "min")


def ema_regime(close, fast: np.ndarray, slow: np.ndarray) -> np.ndarray:
    """+1 if close is above both EMAs, -1 if below both, 0 otherwise (or while an EMA is undefined)."""
    close = as_f(close)
    with np.errstate(invalid="ignore"):
        up = (close > fast) & (close > slow)
        dn = (close < fast) & (close < slow)
    out = np.where(up, 1, np.where(dn, -1, 0)).astype("int8")
    out[np.isnan(fast) | np.isnan(slow)] = 0
    return out
