"""Momentum indicators: RSI, MACD, rate of change."""
from __future__ import annotations

import numpy as np

from ._core import as_f
from .trend import ema


def rsi(close, period: int = 14) -> np.ndarray:
    """Wilder RSI, first value at index ``period``. Flat series -> 50."""
    close = as_f(close)
    n = len(close)
    out = np.full(n, np.nan)
    if n <= period:
        return out
    delta = np.diff(close)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    ag = float(gain[:period].mean())
    al = float(loss[:period].mean())

    def _v(g: float, l: float) -> float:
        if l == 0.0:
            return 100.0 if g > 0.0 else 50.0
        return 100.0 - 100.0 / (1.0 + g / l)

    out[period] = _v(ag, al)
    for i in range(period + 1, n):
        ag = (ag * (period - 1) + gain[i - 1]) / period
        al = (al * (period - 1) + loss[i - 1]) / period
        out[i] = _v(ag, al)
    return out


def macd(close, fast: int = 12, slow: int = 26, signal: int = 9) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(macd line, signal line, histogram). The signal EMA starts once the MACD line exists."""
    close = as_f(close)
    line = ema(close, fast) - ema(close, slow)
    sig = np.full(len(close), np.nan)
    first = np.argmax(~np.isnan(line)) if np.any(~np.isnan(line)) else len(line)
    if len(line) - first >= signal:
        sig[first:] = ema(line[first:], signal)
    return line, sig, line - sig


def roc(close, period: int) -> np.ndarray:
    """close[i] / close[i - period] - 1."""
    close = as_f(close)
    out = np.full(len(close), np.nan)
    if len(close) > period:
        out[period:] = close[period:] / close[:-period] - 1.0
    return out
