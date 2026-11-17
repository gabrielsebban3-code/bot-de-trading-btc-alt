"""Pivots (swing highs / lows) with three detection methods (Step 4).

A pivot is only known at its CONFIRMATION candle (rule 1). Each pivot stores:

* ``idx``          index of the candle holding the extreme (appearance date)
* ``confirm_idx``  index of the candle whose CLOSE confirms it (the pivot exists from ``close_time[confirm_idx]``)
* ``price``        the extreme (high for a pivot high, low for a pivot low)
* ``kind``         +1 pivot high, -1 pivot low
* ``level``        'fractal', 'zigzag', 'minor', 'intermediate' or 'major'
* ``amplitude_atr`` |price - previous opposite pivot price| / ATR at the pivot candle (NaN if unknown)

Methods
-------
* ``fractal_pivots(n)``: high[i] strictly above the n previous highs and >= the n next highs
  (ties: the first candle wins). Confirmed at i + n.
* ``zigzag_pivots(k)``: the running extreme is confirmed when price moves k x ATR against it.
  A candle that makes a new extreme cannot confirm that same extreme (intrabar order unknown).
* ``hierarchical_pivots``: minor = fractal(minor_n); intermediate = fractal of minor pivots of the same kind;
  major = fractal of intermediate pivots. Confirmation = latest confirmation among the pivots used.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

PIVOT_COLS = ["idx", "confirm_idx", "price", "kind", "level", "amplitude_atr"]


def _frame(rows: list[tuple]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=PIVOT_COLS[:5])
    if df.empty:
        df = pd.DataFrame({c: pd.Series(dtype=t) for c, t in
                           zip(PIVOT_COLS[:5], ["int64", "int64", "float64", "int8", "object"])})
    df = df.astype({"idx": "int64", "confirm_idx": "int64", "price": "float64", "kind": "int8"})
    return df.sort_values(["confirm_idx", "idx", "kind"], kind="stable").reset_index(drop=True)


def add_amplitude(piv: pd.DataFrame, atr: np.ndarray) -> pd.DataFrame:
    """Amplitude in ATR versus the previous pivot of the opposite kind (ordered by appearance)."""
    piv = piv.copy()
    amp = np.full(len(piv), np.nan)
    order = np.argsort(piv["idx"].to_numpy(), kind="stable")
    last_price = {1: np.nan, -1: np.nan}
    for j in order:
        k = int(piv.at[j, "kind"])
        prev = last_price[-k]
        a = atr[int(piv.at[j, "idx"])] if len(atr) else np.nan
        if np.isfinite(prev) and np.isfinite(a) and a > 0:
            amp[j] = abs(piv.at[j, "price"] - prev) / a
        last_price[k] = piv.at[j, "price"]
    piv["amplitude_atr"] = amp
    return piv


def fractal_pivots(high, low, n: int, level: str = "fractal") -> pd.DataFrame:
    h = np.asarray(high, dtype="float64")
    l = np.asarray(low, dtype="float64")
    size = len(h)
    rows = []
    if size < 2 * n + 1:
        return _frame(rows)
    hw = np.lib.stride_tricks.sliding_window_view(h, 2 * n + 1)
    lw = np.lib.stride_tricks.sliding_window_view(l, 2 * n + 1)
    centre_h, centre_l = hw[:, n], lw[:, n]
    is_ph = (centre_h > hw[:, :n].max(axis=1)) & (centre_h >= hw[:, n + 1:].max(axis=1))
    is_pl = (centre_l < lw[:, :n].min(axis=1)) & (centre_l <= lw[:, n + 1:].min(axis=1))
    for j in np.nonzero(is_ph)[0]:
        rows.append((j + n, j + 2 * n, float(h[j + n]), 1, level))
    for j in np.nonzero(is_pl)[0]:
        rows.append((j + n, j + 2 * n, float(l[j + n]), -1, level))
    return _frame(rows)


def zigzag_pivots(high, low, atr, k: float) -> pd.DataFrame:
    h = np.asarray(high, dtype="float64")
    l = np.asarray(low, dtype="float64")
    a = np.asarray(atr, dtype="float64")
    rows = []
    trend = 0          # 0 unknown, +1 tracking a high (last pivot was a low), -1 tracking a low
    max_i = min_i = -1
    for i in range(len(h)):
        if not np.isfinite(a[i]):
            continue
        if max_i < 0:
            max_i = min_i = i
            continue
        new_high = h[i] > h[max_i]
        new_low = l[i] < l[min_i]
        conf_high = trend >= 0 and not new_high and l[i] <= h[max_i] - k * a[i]
        conf_low = trend <= 0 and not new_low and h[i] >= l[min_i] + k * a[i]
        if conf_high and conf_low:          # unknown trend, both reversals: the older extreme is confirmed
            conf_high, conf_low = max_i < min_i, min_i <= max_i
        if conf_high:
            rows.append((max_i, i, float(h[max_i]), 1, "zigzag"))
            trend, min_i = -1, i
            continue
        if conf_low:
            rows.append((min_i, i, float(l[min_i]), -1, "zigzag"))
            trend, max_i = 1, i
            continue
        if new_high and trend >= 0:
            max_i = i
        if new_low and trend <= 0:
            min_i = i
    return _frame(rows)


def _pivots_of_pivots(piv: pd.DataFrame, n: int, level: str) -> pd.DataFrame:
    """Fractal rule applied to the ordered sequence of pivots of each kind."""
    rows = []
    for kind in (1, -1):
        p = piv[piv["kind"] == kind].sort_values("idx", kind="stable").reset_index(drop=True)
        price = p["price"].to_numpy() * kind          # compare highs directly, lows by their negative
        conf = p["confirm_idx"].to_numpy()
        for j in range(n, len(p) - n):
            left = price[j - n:j]
            right = price[j + 1:j + n + 1]
            if price[j] > left.max() and price[j] >= right.max():
                rows.append((int(p.at[j, "idx"]), int(conf[j:j + n + 1].max()), float(p.at[j, "price"]), kind, level))
    return _frame(rows)


def hierarchical_pivots(high, low, minor_n: int = 2, intermediate_n: int = 2, major_n: int = 2) -> pd.DataFrame:
    minor = fractal_pivots(high, low, minor_n, level="minor")
    inter = _pivots_of_pivots(minor, intermediate_n, "intermediate")
    major = _pivots_of_pivots(inter, major_n, "major")
    return pd.concat([minor, inter, major], ignore_index=True).sort_values(
        ["confirm_idx", "idx", "kind"], kind="stable").reset_index(drop=True)


def detect(method: str, high, low, atr, cfg_structure: dict) -> pd.DataFrame:
    """Dispatch on the method name used in config grids: 'fractal', 'zigzag', 'hierarchical'."""
    if method == "fractal":
        piv = fractal_pivots(high, low, int(cfg_structure["fractal_n"]))
    elif method == "zigzag":
        piv = zigzag_pivots(high, low, atr, float(cfg_structure["zigzag_atr_mult"]))
    elif method == "hierarchical":
        hc = cfg_structure["hierarchy"]
        piv = hierarchical_pivots(high, low, hc["minor_n"], hc["intermediate_n"], hc["major_n"])
    else:
        raise ValueError(method)
    return add_amplitude(piv, np.asarray(atr, dtype="float64"))


def last_confirmed(size: int, piv: pd.DataFrame, kind: int, level: str | None = None) -> tuple[np.ndarray, np.ndarray]:
    """For every candle t: (price, idx) of the latest pivot of ``kind`` confirmed at or before t. NaN / -1 before."""
    p = piv[piv["kind"] == kind]
    if level is not None:
        p = p[p["level"] == level]
    p = p.sort_values(["confirm_idx", "idx"], kind="stable")
    price = np.full(size, np.nan)
    idx = np.full(size, -1, dtype="int64")
    for c, i, pr in zip(p["confirm_idx"].to_numpy(), p["idx"].to_numpy(), p["price"].to_numpy()):
        if c < size:
            price[c] = pr
            idx[c] = i
    # forward fill
    mask = idx >= 0
    pos = np.where(mask, np.arange(size), -1)
    pos = np.maximum.accumulate(pos)
    out_price = np.where(pos >= 0, price[np.clip(pos, 0, None)], np.nan)
    out_idx = np.where(pos >= 0, idx[np.clip(pos, 0, None)], -1)
    return out_price, out_idx


def precision_report(piv: pd.DataFrame, high, low, horizon: int) -> dict:
    """Quality of detected pivots: confirmation delay and how often the pivot stays the extreme afterwards.

    'held' = no candle in the ``horizon`` candles after confirmation went beyond the pivot price.
    """
    h = np.asarray(high, dtype="float64")
    l = np.asarray(low, dtype="float64")
    delays, held = [], []
    for i, c, pr, k in zip(piv["idx"], piv["confirm_idx"], piv["price"], piv["kind"]):
        delays.append(c - i)
        seg_end = min(len(h), c + 1 + horizon)
        if c + 1 >= seg_end:
            continue
        held.append(bool(h[c + 1:seg_end].max() <= pr) if k == 1 else bool(l[c + 1:seg_end].min() >= pr))
    return {"n": int(len(piv)), "mean_delay_bars": float(np.mean(delays)) if delays else float("nan"),
            "held_share": float(np.mean(held)) if held else float("nan")}
