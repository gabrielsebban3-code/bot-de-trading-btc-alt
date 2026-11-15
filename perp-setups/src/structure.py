"""Market structure primitives: pivots, liquidity sweeps, structure breaks, FVG, order blocks.

Everything is causal: a function evaluated "at candle t" only reads candles 0..t (closed candles).
A pivot of period n located at candle p is only visible from candle p + n onwards.
"""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------- pivots

def pivot_flags(high: np.ndarray, low: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Boolean arrays (is_pivot_high, is_pivot_low) indexed at the pivot candle.

    A pivot high is strictly higher than the n candles before and the n candles after.
    The flag at index p must NOT be read before candle p + n has closed (see ``confirmed_pivots``).
    """
    high = np.asarray(high, dtype="float64")
    low = np.asarray(low, dtype="float64")
    size = len(high)
    is_ph = np.zeros(size, dtype=bool)
    is_pl = np.zeros(size, dtype=bool)
    if size < 2 * n + 1:
        return is_ph, is_pl
    hw = np.lib.stride_tricks.sliding_window_view(high, n)
    lw = np.lib.stride_tricks.sliding_window_view(low, n)
    # hw[i] covers candles i .. i+n-1
    left_max = hw.max(axis=1)[: size - 2 * n]          # candles p-n .. p-1 for p = n .. size-n-1
    right_max = hw.max(axis=1)[n + 1: size - n + 1]    # candles p+1 .. p+n
    left_min = lw.min(axis=1)[: size - 2 * n]
    right_min = lw.min(axis=1)[n + 1: size - n + 1]
    mid_h = high[n: size - n]
    mid_l = low[n: size - n]
    is_ph[n: size - n] = (mid_h > left_max) & (mid_h > right_max)
    is_pl[n: size - n] = (mid_l < left_min) & (mid_l < right_min)
    return is_ph, is_pl


def confirmed_pivots(high: np.ndarray, low: np.ndarray, n: int) -> dict:
    """Pivot indices, levels and confirmation indices (pivot index + n)."""
    is_ph, is_pl = pivot_flags(high, low, n)
    ph_idx = np.nonzero(is_ph)[0]
    pl_idx = np.nonzero(is_pl)[0]
    return {
        "n": n,
        "ph_idx": ph_idx, "ph_level": np.asarray(high, dtype="float64")[ph_idx], "ph_conf": ph_idx + n,
        "pl_idx": pl_idx, "pl_level": np.asarray(low, dtype="float64")[pl_idx], "pl_conf": pl_idx + n,
    }


def last_confirmed_level(size: int, idx: np.ndarray, level: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """For every candle t: (level, pivot index) of the most recent pivot confirmed at or before t.

    NaN / -1 while no pivot is confirmed. A pivot at p appears from t = p + n.
    """
    out_level = np.full(size, np.nan)
    out_idx = np.full(size, -1, dtype="int64")
    if len(idx) == 0:
        return out_level, out_idx
    conf = idx + n
    pos = np.searchsorted(conf, np.arange(size), side="right") - 1
    ok = pos >= 0
    out_level[ok] = level[pos[ok]]
    out_idx[ok] = idx[pos[ok]]
    return out_level, out_idx


# ---------------------------------------------------------------- liquidity sweeps (family A, step 1)

def find_sweeps(high: np.ndarray, low: np.ndarray, close: np.ndarray, piv: dict, side: str,
                lookback: int = 50, tol: float = 0.0015, min_group: int = 2) -> list[tuple[int, float]]:
    """Sweeps of equal highs (side='high') or equal lows (side='low').

    At candle t, the pivots considered are those located in [t - lookback, t - 1] and confirmed
    (pivot index + n <= t). A liquidity level is the extreme of a group of at least ``min_group``
    pivots whose levels differ by less than ``tol`` (relative to the highest level of the group).
    The level must still be intact: no candle after a group member may have traded beyond it.
    The sweep candle trades beyond the level with its wick but closes back on the other side.

    Returns a list of (t, level), at most one per candle (outermost valid level).
    """
    n = piv["n"]
    if side == "high":
        idx, lvl = piv["ph_idx"], piv["ph_level"]
        price = np.asarray(high, dtype="float64")
    else:
        idx, lvl = piv["pl_idx"], piv["pl_level"]
        price = np.asarray(low, dtype="float64")
    close = np.asarray(close, dtype="float64")
    size = len(price)
    sweeps: list[tuple[int, float]] = []
    if len(idx) < min_group:
        return sweeps
    conf = idx + n
    lo_ptr = 0   # first pivot with idx >= t - lookback
    hi_ptr = 0   # first pivot with conf > t  (pivots [lo_ptr, hi_ptr) are visible)
    npiv = len(idx)
    is_high = side == "high"
    for t in range(size):
        while hi_ptr < npiv and conf[hi_ptr] <= t:
            hi_ptr += 1
        while lo_ptr < hi_ptr and idx[lo_ptr] < t - lookback:
            lo_ptr += 1
        if hi_ptr - lo_ptr < min_group:
            continue
        ext, cl = price[t], close[t]
        cand = []
        for k in range(lo_ptr, hi_ptr):
            level = lvl[k]
            if is_high:
                if cl < level < ext:
                    cand.append(k)
            elif ext < level < cl:
                cand.append(k)
        if not cand:
            continue
        # outermost level first
        cand.sort(key=lambda k: (-lvl[k], k) if is_high else (lvl[k], k))
        for k in cand:
            level = lvl[k]
            members = 0
            for q in range(lo_ptr, hi_ptr):
                lq = lvl[q]
                if is_high:
                    if lq > level or (level - lq) / level >= tol:
                        continue
                    seg = price[idx[q] + 1: t]
                    if len(seg) and seg.max() > level:
                        continue
                else:
                    if lq < level or (lq - level) / lq >= tol:
                        continue
                    seg = price[idx[q] + 1: t]
                    if len(seg) and seg.min() < level:
                        continue
                members += 1
            # the top pivot k itself must be one of the intact members
            segk = price[idx[k] + 1: t]
            top_intact = not len(segk) or (segk.max() <= level if is_high else segk.min() >= level)
            if top_intact and members >= min_group:
                sweeps.append((t, float(level)))
                break
    return sweeps


# ---------------------------------------------------------------- structure break (family A, step 2)

def find_mss(t_sweep: int, direction: int, ref_level: float, stop_price: float,
             open_: np.ndarray, high: np.ndarray, low: np.ndarray, close: np.ndarray, atr: np.ndarray,
             window: int = 10, require_displacement: bool = False, disp_mult: float = 1.5) -> int:
    """Index of the structure-break candle within ``window`` candles after the sweep, or -1.

    direction = -1 after a sweep of highs (short setup): the close must break below ``ref_level``
    (last confirmed pivot low at sweep time). direction = +1: close above the last pivot high.
    The break candle is the FIRST close beyond the level. With ``require_displacement`` its body
    must be at least ``disp_mult`` x ATR, otherwise the setup is dropped.
    The setup is dropped if the stop level is touched before the break.
    """
    if not np.isfinite(ref_level):
        return -1
    # the level must not already be broken when the sweep candle closes
    if direction < 0 and close[t_sweep] < ref_level:
        return -1
    if direction > 0 and close[t_sweep] > ref_level:
        return -1
    last = min(t_sweep + window, len(close) - 1)
    for u in range(t_sweep + 1, last + 1):
        if direction < 0:
            if high[u] >= stop_price:
                return -1
            broke = close[u] < ref_level
            body = open_[u] - close[u]
        else:
            if low[u] <= stop_price:
                return -1
            broke = close[u] > ref_level
            body = close[u] - open_[u]
        if broke:
            if require_displacement:
                if not np.isfinite(atr[u]) or body < disp_mult * atr[u]:
                    return -1
            return u
    return -1


# ---------------------------------------------------------------- entry zones (family A, step 3)

def fvg_zone(i: int, direction: int, high: np.ndarray, low: np.ndarray) -> tuple[float, float] | None:
    """Fair value gap whose middle candle is ``i`` (needs candle i + 1 closed).

    direction = -1 (bearish): gap between high[i+1] (bottom) and low[i-1] (top).
    direction = +1 (bullish): gap between high[i-1] (bottom) and low[i+1] (top).
    Returns (bottom, top) or None when the candles overlap.
    """
    if i - 1 < 0 or i + 1 >= len(high):
        return None
    if direction < 0:
        bottom, top = high[i + 1], low[i - 1]
    else:
        bottom, top = high[i - 1], low[i + 1]
    if bottom < top:
        return float(bottom), float(top)
    return None


def last_opposite_candle(open_: np.ndarray, close: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """For every candle t: index of the last bullish candle and of the last bearish candle at or before t."""
    size = len(open_)
    ar = np.arange(size)
    bull = np.where(np.asarray(close) > np.asarray(open_), ar, -1)
    bear = np.where(np.asarray(close) < np.asarray(open_), ar, -1)
    return np.maximum.accumulate(bull), np.maximum.accumulate(bear)


def order_block_zone(i: int, direction: int, open_: np.ndarray, close: np.ndarray,
                     last_bull: np.ndarray, last_bear: np.ndarray) -> tuple[float, float] | None:
    """Body (bottom, top) of the last opposite-coloured candle before the displacement candle ``i``.

    direction = -1 (short): last bullish candle before i. direction = +1 (long): last bearish candle.
    """
    if i - 1 < 0:
        return None
    j = int(last_bull[i - 1]) if direction < 0 else int(last_bear[i - 1])
    if j < 0:
        return None
    lo_, hi_ = sorted((float(open_[j]), float(close[j])))
    return lo_, hi_
