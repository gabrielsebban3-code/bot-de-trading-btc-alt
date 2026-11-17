"""Low-level causal helpers. Every output value at index i depends on inputs 0..i only."""
from __future__ import annotations

import numpy as np


def as_f(x) -> np.ndarray:
    return np.asarray(x, dtype="float64")


def sma(x, period: int) -> np.ndarray:
    x = as_f(x)
    out = np.full(len(x), np.nan)
    if len(x) < period:
        return out
    cs = np.cumsum(np.insert(x, 0, 0.0))
    out[period - 1:] = (cs[period:] - cs[:-period]) / period
    return out


def wilder(x, period: int, start: int) -> np.ndarray:
    """Wilder smoothing of x[start:], first value at index start + period - 1 (simple mean seed)."""
    x = as_f(x)
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


def rolling_prev(x, period: int, fn: str) -> np.ndarray:
    """max / min / mean of the ``period`` values BEFORE index i (current value excluded)."""
    x = as_f(x)
    out = np.full(len(x), np.nan)
    if len(x) > period:
        win = np.lib.stride_tricks.sliding_window_view(x, period)
        agg = {"max": win.max, "min": win.min, "mean": win.mean}[fn](axis=1)
        out[period:] = agg[:-1]
    return out


def rolling_incl(x, period: int, fn: str) -> np.ndarray:
    """max / min / mean / std of the last ``period`` values, current value INCLUDED."""
    x = as_f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= period:
        win = np.lib.stride_tricks.sliding_window_view(x, period)
        if fn == "std":
            out[period - 1:] = win.std(axis=1, ddof=0)
        else:
            out[period - 1:] = {"max": win.max, "min": win.min, "mean": win.mean}[fn](axis=1)
    return out


def rolling_rank_pct(x, period: int) -> np.ndarray:
    """Share of the last ``period`` values (current included) that are <= the current value."""
    x = as_f(x)
    out = np.full(len(x), np.nan)
    if len(x) >= period:
        win = np.lib.stride_tricks.sliding_window_view(x, period)
        cur = win[:, -1][:, None]
        valid = ~np.isnan(win).any(axis=1)
        out[period - 1:] = np.where(valid, (win <= cur).mean(axis=1), np.nan)
    return out
