"""Study 4: seven methods with an ATR stop and a fixed target in R (families M1 to M7).

Same contract as ``setups.py``: closed candles only, one order at the close of the signal candle
(``order_time`` = close time of that candle = open time of the next one). Importing this module
registers the seven functions in ``setups.SIGNAL_FUNCS``.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import indicators as ind
from .data import TF_MS
from .setups import DAY_MS, SIGNAL_FUNCS, SymbolContext, _edge, _frame, funding_zscore


def _emit(ctx: SymbolContext, fam: str, p: dict, long_mask: np.ndarray, short_mask: np.ndarray) -> pd.DataFrame:
    """Market orders with a stop at sl_atr x ATR and a target at tp_r x R for the flagged signal candles."""
    fx = ctx.cfg["families"][fam]["fixed"]
    tf = p["timeframe"]
    b = ctx.bars[tf]
    atr = b.atr
    ok = b.valid(ctx.warmup_ms) & np.isfinite(atr)
    both = long_mask & short_mask                      # opposite signals on one candle: neither is taken
    sl = float(p.get("sl_atr", fx["sl_atr"]))
    rows = []
    for direction, mask in ((1, long_mask & ~both), (-1, short_mask & ~both)):
        for t in np.nonzero(mask & ok)[0]:
            row = {"order_time": int(b.ct[t]), "direction": direction, "order_type": "market",
                   "stop_dist": float(sl * atr[t]), "atr": float(atr[t])}
            if p.get("exit") == "trail":                # study 6: chandelier trailing stop, no target
                row["trail_mult"] = float(p.get("trail_atr", fx["trail_atr"]))
            else:
                row["tp_r"] = float(p.get("tp_r", fx.get("tp_r")))
            rows.append(row)
    return _frame(ctx, tf, rows)


# ---------------------------------------------------------------- M1: SMC (sweep + order block + FVG)

def _smc_long(o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, n: int, fvg_window: int,
              ob_lookback: int, retest_window: int) -> np.ndarray:
    size = len(c)
    out = np.zeros(size, dtype=bool)
    prev_low = ind.rolling_min_prev(l, n)
    with np.errstate(invalid="ignore"):
        sweeps = np.nonzero((l < prev_low) & (c > prev_low))[0]
    for s in sweeps:
        for d in range(s + 1, min(s + 1 + fvg_window, size - 1)):          # d = candle creating the FVG
            if not (c[d] > o[d] and l[d + 1] > h[d - 1]):
                continue
            ob = -1
            for j in range(d - 1, max(d - 1 - ob_lookback, -1), -1):        # last down candle before d
                if c[j] < o[j]:
                    ob = j
                    break
            if ob < 0:
                continue
            top, bottom, ob_low = l[d + 1], h[d - 1], l[ob]
            mid = 0.5 * (top + bottom)
            for r in range(d + 2, min(d + 2 + retest_window, size)):
                if c[r] < ob_low:                                           # setup invalidated
                    break
                if l[r] <= top and c[r] > o[r] and c[r] > mid:
                    out[r] = True
                    break
            break                                                           # first FVG after the sweep only
    return out


def signals_M1(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M1"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    n = int(round(float(p["sweep_n"])))
    args = (n, int(fx["fvg_window"]), int(fx["ob_lookback"]), int(fx["retest_window"]))
    longs = _smc_long(b.o, b.h, b.l, b.c, *args)
    shorts = _smc_long(-b.o, -b.l, -b.h, -b.c, *args)                       # mirror image for sells
    return _emit(ctx, "M1", p, longs, shorts)


# ---------------------------------------------------------------- M2: Donchian breakout with volume

def signals_M2(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M2"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    hi, lo = ind.donchian(b.h, b.l, int(round(float(p["donchian_n"]))))
    with np.errstate(invalid="ignore"):
        vol_ok = b.v > fx["volume_mult"] * ind.rolling_mean_prev(b.v, int(fx["volume_window"]))
        return _emit(ctx, "M2", p, (b.c > hi) & vol_ok, (b.c < lo) & vol_ok)


# ---------------------------------------------------------------- M3: trend pullback on an EMA

def signals_M3(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M3"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    fast, mid, slow = b.ema(int(fx["ema_fast"])), b.ema(int(fx["ema_mid"])), b.ema(int(fx["ema_slow"]))
    pull = b.ema(int(round(float(p["ema_pullback"]))))
    with np.errstate(invalid="ignore"):
        longs = (b.c > slow) & (fast > mid) & (b.l <= pull) & (b.c > pull) & (b.c > b.o)
        shorts = (b.c < slow) & (fast < mid) & (b.h >= pull) & (b.c < pull) & (b.c < b.o)
    return _emit(ctx, "M3", p, _edge(longs), _edge(shorts))


# ---------------------------------------------------------------- M4: mean reversion

def signals_M4(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M4"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    _, upper, lower = b.bb(float(fx["bb_k"]))
    low_thr = float(p["rsi_low"])
    with np.errstate(invalid="ignore"):
        calm = b.adx < fx["adx_max"]
        longs = calm & (b.c < lower) & (b.rsi < low_thr)
        shorts = calm & (b.c > upper) & (b.rsi > 100.0 - low_thr)
    return _emit(ctx, "M4", p, longs, shorts)


# ---------------------------------------------------------------- M5: return to the session VWAP

def session_vwap(ot: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray, v: np.ndarray):
    """(vwap, volume-weighted standard deviation, ms since 00:00 UTC, session id) candle by candle."""
    size = len(c)
    vwap, sd = np.full(size, np.nan), np.full(size, np.nan)
    day = ot // DAY_MS
    typical = (h + l + c) / 3.0
    starts = np.nonzero(np.r_[True, day[1:] != day[:-1]])[0] if size else np.zeros(0, dtype=int)
    for a, z in zip(starts, np.r_[starts[1:], size]):
        x = typical[a:z] - typical[a]                 # relative prices keep the variance numerically exact
        w = v[a:z]
        cw = np.cumsum(w)
        with np.errstate(divide="ignore", invalid="ignore"):
            m = np.cumsum(x * w) / cw
            var = np.cumsum(x * x * w) / cw - m * m
        vwap[a:z] = typical[a] + m
        sd[a:z] = np.sqrt(np.maximum(var, 0.0))
    return vwap, sd, ot - day * DAY_MS, day


def signals_M5(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M5"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    vwap, sd, since, day = b.get("vwap", lambda: session_vwap(b.ot, b.h, b.l, b.c, b.v))
    k = float(p["vwap_k"])
    longs, shorts = np.zeros(b.size, dtype=bool), np.zeros(b.size, dtype=bool)
    if b.size > 1:
        with np.errstate(invalid="ignore"):
            lower, upper = vwap - k * sd, vwap + k * sd
            same = (day[1:] == day[:-1]) & (since[1:] >= fx["session_min_hours"] * 3_600_000) & (sd[1:] > 0) & (sd[:-1] > 0)
            longs[1:] = same & (b.c[:-1] < lower[:-1]) & (b.c[1:] > lower[1:])
            shorts[1:] = same & (b.c[:-1] > upper[:-1]) & (b.c[1:] < upper[1:])
    return _emit(ctx, "M5", p, longs, shorts)


# ---------------------------------------------------------------- M6: extreme funding, contrarian

def signals_M6(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M6"]["fixed"]
    tf = p["timeframe"]
    b = ctx.bars[tf]
    z = ctx._cache.setdefault(("M6_z", fx["z_window"]), funding_zscore(ctx.f_rate, int(fx["z_window"])))
    thr = float(p["z"])
    longs, shorts = np.zeros(b.size, dtype=bool), np.zeros(b.size, dtype=bool)
    with np.errstate(invalid="ignore"):
        extreme = np.nonzero(np.abs(z) >= thr)[0]
    for s in extreme:
        t0 = int(ctx.f_time[s])
        k = int(np.searchsorted(b.ot, t0, side="left"))     # first candle opened at or after the settlement
        if k >= b.size or b.ot[k] - t0 >= TF_MS[tf]:
            continue
        (shorts if z[s] > 0 else longs)[k] = True
    return _emit(ctx, "M6", p, longs, shorts)


# ---------------------------------------------------------------- M7: volume spike then candle break

def signals_M7(ctx: SymbolContext, p: dict) -> pd.DataFrame:
    fx = ctx.cfg["families"]["M7"]["fixed"]
    b = ctx.bars[p["timeframe"]]
    longs, shorts = np.zeros(b.size, dtype=bool), np.zeros(b.size, dtype=bool)
    with np.errstate(invalid="ignore"):
        spikes = np.nonzero(b.v >= float(p["vol_mult"]) * ind.rolling_mean_prev(b.v, int(fx["volume_window"])))[0]
    for s in spikes:
        for t in range(s + 1, min(s + 1 + int(fx["break_window"]), b.size)):
            if b.c[t] > b.h[s]:
                longs[t] = True
                break
            if b.c[t] < b.l[s]:
                shorts[t] = True
                break
    return _emit(ctx, "M7", p, longs, shorts)


SIGNAL_FUNCS.update({"M1": signals_M1, "M2": signals_M2, "M3": signals_M3, "M4": signals_M4,
                     "M5": signals_M5, "M6": signals_M6, "M7": signals_M7})
