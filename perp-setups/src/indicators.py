"""Hand-made indicators (numpy only). Every value at index i uses candles 0..i only.

Conventions
-----------
* ``ema``: seeded with the simple mean of the first ``period`` values, alpha = 2 / (period + 1).
* Wilder smoothing (ATR, RSI, ADX): first value = simple mean of the first ``period`` inputs,
  then ``prev + (x - prev) / period``.
* Values that cannot be computed yet are NaN.
"""
from __future__ import annotations

import numpy as np


def sma(x: np.ndarray, period: int) -> np.ndarray:
    x = np.asarray(x, dtype="float64")
    out = np.full(len(x), np.nan)
    if len(x) < period:
        return out
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    return out


def ema(x: np.ndarray, period: int) -> np.ndarray:
    x = np.asarray(x, dtype="float64")
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


def _wilder(x: np.ndarray, period: int, start: int) -> np.ndarray:
    """Wilder average of x[start:], first value at index start + period - 1."""
    n = len(x)
    out = np.full(n, np.nan)
    first = start + period - 1
    if n <= first:
        return out
    prev = float(x[start:start + period].mean())
    out[first] = prev
    for i in range(first + 1, n):
        prev = prev + (x[i] - prev) / period
        out[i] = prev
    return out


def true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """True range; index 0 is NaN (no previous close)."""
    high, low, close = (np.asarray(a, dtype="float64") for a in (high, low, close))
    tr = np.full(len(high), np.nan)
    if len(high) > 1:
        pc = close[:-1]
        tr[1:] = np.maximum(high[1:] - low[1:], np.maximum(np.abs(high[1:] - pc), np.abs(low[1:] - pc)))
    return tr


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder ATR. First value at index ``period`` (mean of TR[1..period])."""
    return _wilder(true_range(high, low, close), period, start=1)


def rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder RSI. First value at index ``period``."""
    close = np.asarray(close, dtype="float64")
    n = len(close)
    out = np.full(n, np.nan)
    if n <= period:
        return out
    delta = np.diff(close)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    ag = float(gain[:period].mean())
    al = float(loss[:period].mean())

    def _value(g: float, l: float) -> float:
        if l == 0.0:
            return 100.0 if g > 0.0 else 50.0
        return 100.0 - 100.0 / (1.0 + g / l)

    out[period] = _value(ag, al)
    for i in range(period + 1, n):
        ag = (ag * (period - 1) + gain[i - 1]) / period
        al = (al * (period - 1) + loss[i - 1]) / period
        out[i] = _value(ag, al)
    return out


def adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """Wilder ADX. First value at index ``2 * period - 1``."""
    high, low, close = (np.asarray(a, dtype="float64") for a in (high, low, close))
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
    tr = true_range(high, low, close)
    tr_s = _wilder(tr, period, start=1)
    pdm_s = _wilder(plus_dm, period, start=1)
    mdm_s = _wilder(minus_dm, period, start=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        pdi = 100.0 * pdm_s / tr_s
        mdi = 100.0 * mdm_s / tr_s
        denom = pdi + mdi
        dx = np.where(denom > 0, 100.0 * np.abs(pdi - mdi) / denom, 0.0)
    dx[np.isnan(tr_s)] = np.nan
    return _wilder(dx, period, start=period)


def bollinger(close: np.ndarray, period: int = 20, k: float = 2.0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(middle, upper, lower) with population standard deviation over the last ``period`` closes."""
    close = np.asarray(close, dtype="float64")
    n = len(close)
    mid = sma(close, period)
    sd = np.full(n, np.nan)
    if n >= period:
        win = np.lib.stride_tricks.sliding_window_view(close, period)
        sd[period - 1:] = win.std(axis=1, ddof=0)
    return mid, mid + k * sd, mid - k * sd


def rolling_max_prev(x: np.ndarray, period: int) -> np.ndarray:
    """Max of the ``period`` values BEFORE index i (current value excluded)."""
    x = np.asarray(x, dtype="float64")
    out = np.full(len(x), np.nan)
    if len(x) > period:
        win = np.lib.stride_tricks.sliding_window_view(x, period)
        out[period:] = win.max(axis=1)[:-1]
    return out


def rolling_min_prev(x: np.ndarray, period: int) -> np.ndarray:
    """Min of the ``period`` values BEFORE index i (current value excluded)."""
    x = np.asarray(x, dtype="float64")
    out = np.full(len(x), np.nan)
    if len(x) > period:
        win = np.lib.stride_tricks.sliding_window_view(x, period)
        out[period:] = win.min(axis=1)[:-1]
    return out


def rolling_mean_prev(x: np.ndarray, period: int) -> np.ndarray:
    """Mean of the ``period`` values BEFORE index i (current value excluded)."""
    x = np.asarray(x, dtype="float64")
    out = np.full(len(x), np.nan)
    if len(x) > period:
        out[period:] = sma(x, period)[period - 1:-1]
    return out


def donchian(high: np.ndarray, low: np.ndarray, period: int) -> tuple[np.ndarray, np.ndarray]:
    """(highest high, lowest low) of the ``period`` candles before the current one."""
    return rolling_max_prev(high, period), rolling_min_prev(low, period)
