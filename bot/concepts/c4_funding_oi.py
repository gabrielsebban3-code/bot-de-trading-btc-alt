"""C4 - Funding / open interest (Step 3), rules frozen in PROTOCOLE_PHASE3.md section 2.

* funding_abs: z-score of the funding versus the settlements of the W previous days; z >= s -> short
  (crowded longs), z <= -s -> long. Signal at the first 1h close at or after the settlement.
* funding_rel: same on (pair funding - median funding of the universe at the same settlement).
* oi_purge: open interest down >= theta over 24 h with price down >= 3 % -> long; with price up >= 3 % -> short.
  First candle of each episode only.
Exit: stop 2 ATR(1h), target 2 R, time exit after 48 h.

``SymbolData`` must carry ``funding`` (time, rate), ``oi`` (time, oi) and ``xs_funding`` (time, median) DataFrames.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS, HOUR_MS
from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..data.resampler import align_closed
from .base import SymbolData, direction_allowed, merged_params, variant_id

CONCEPT = "C4"


def time_zscore(t: np.ndarray, x: np.ndarray, window_ms: int, min_obs: int = 5) -> np.ndarray:
    """z of x[i] versus the observations with time in [t[i] - window, t[i]) (current excluded), ddof = 1."""
    t = np.asarray(t, dtype="int64")
    x = np.asarray(x, dtype="float64")
    cs = np.concatenate(([0.0], np.cumsum(x)))
    cs2 = np.concatenate(([0.0], np.cumsum(x * x)))
    lo = np.searchsorted(t, t - window_ms, side="left")
    hi = np.arange(len(t))                       # current excluded
    n = hi - lo
    s1 = cs[hi] - cs[lo]
    s2 = cs2[hi] - cs2[lo]
    out = np.full(len(t), np.nan)
    ok = n >= min_obs
    mean = np.where(ok, s1 / np.maximum(n, 1), np.nan)
    var = np.where(n > 1, (s2 - n * mean ** 2) / np.maximum(n - 1, 1), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = (x - mean) / np.sqrt(var)
    out[ok] = np.where(var[ok] > 0, z[ok], 0.0)
    return out


def funding_series(sd: SymbolData, relative: bool) -> tuple[np.ndarray, np.ndarray]:
    f = sd.funding
    if f is None or f.empty:
        return np.zeros(0, dtype="int64"), np.zeros(0)
    t = (f["time"].to_numpy(dtype="int64") // 60_000) * 60_000
    x = f["rate"].to_numpy(dtype="float64")
    if relative:
        xs = sd.xs_funding
        med = align_closed(t, xs["time"].to_numpy(dtype="int64"), xs["median"].to_numpy(dtype="float64"))
        # the median of the same settlement hour only (stale medians are not used)
        same = align_closed(t, xs["time"].to_numpy(dtype="int64"), xs["time"].to_numpy(dtype="float64"))
        med = np.where(np.abs(t - same) <= HOUR_MS, med, np.nan)
        keep = np.isfinite(med)
        t, x = t[keep], x[keep] - med[keep]
    return t, x


def funding_z_at(sd: SymbolData, t_ms: np.ndarray, window_days: float) -> np.ndarray:
    """z-score of the latest settlement known at each instant (used by the funding filter)."""
    key = ("fz", float(window_days))

    def _build():
        ft, fx = funding_series(sd, relative=False)
        return ft, time_zscore(ft, fx, int(window_days * DAY_MS))
    ft, z = sd.cached(key, _build)
    return align_closed(t_ms, ft, z) if len(ft) else np.full(len(t_ms), np.nan)


def crowded_filter(signals: list[Signal], data: dict[str, SymbolData], window_days: float, zmax: float) -> list[Signal]:
    """Drop longs when the funding z-score is >= zmax (crowded longs) and shorts when <= -zmax."""
    out = []
    by_sym: dict[str, list[Signal]] = {}
    for s in signals:
        by_sym.setdefault(s.symbol, []).append(s)
    for sym, ss in by_sym.items():
        z = funding_z_at(data[sym], np.array([s.generated_at for s in ss], dtype="int64"), window_days)
        for s, zz in zip(ss, z):
            if np.isfinite(zz) and ((int(s.direction) > 0 and zz >= zmax) or (int(s.direction) < 0 and zz <= -zmax)):
                continue
            out.append(s)
    return out


def generate_signals(data: dict[str, SymbolData], cfg: dict, params: dict) -> list[Signal]:
    """params: signal ('funding_abs'|'funding_rel'|'oi_purge'), window_days & z, or oi_drop; direction (both)."""
    params = dict(params)
    params.setdefault("direction", "both")
    p = merged_params(cfg, "c4", params)
    tf = p["tf"]
    vid = variant_id(CONCEPT, params)
    warm = int(cfg["engine"]["warmup_days"])
    rule = ExitRule(ExitKind.TAKE_PROFIT, tp_r=float(p["tp_r"]), max_hold_bars=int(round(float(p["max_hold_bars"]))), tf=tf)
    stop_atr = float(p["stop_atr"])
    out: list[Signal] = []
    for sym, sd in data.items():
        b = sd.bars[tf]
        if b.n == 0:
            continue
        a = b.atr(14)
        ok = b.valid(warm, float(p["min_signal_volume"])) & np.isfinite(a)
        cand: list[tuple[int, int, str]] = []          # (bar index, direction, reason)
        if p["signal"] in ("funding_abs", "funding_rel"):
            ft, fx = funding_series(sd, relative=p["signal"] == "funding_rel")
            if len(ft) == 0:
                continue
            z = time_zscore(ft, fx, int(float(p["window_days"]) * DAY_MS))
            thr = float(p["z"])
            k = np.searchsorted(b.ct, ft, side="left")        # first 1h close at or after the settlement
            for i in np.nonzero(np.isfinite(z) & (np.abs(z) >= thr))[0]:
                j = int(k[i])
                if j >= b.n or b.ct[j] - ft[i] > HOUR_MS:
                    continue
                d = -1 if z[i] > 0 else 1
                cand.append((j, d, f"funding {'relatif ' if p['signal'] == 'funding_rel' else ''}z = {z[i]:+.2f} "
                                   f"sur {p['window_days']} j : positionnement {'acheteur' if d < 0 else 'vendeur'} excessif"))
        else:
            o = sd.oi
            if o is None or o.empty:
                continue
            ot_, ov = o["time"].to_numpy(dtype="int64"), o["oi_value"].to_numpy(dtype="float64")
            look = int(float(p["oi_lookback_h"])) * HOUR_MS
            now_v = align_closed(b.ct, ot_, ov)
            now_t = align_closed(b.ct, ot_, ot_.astype("float64"))
            prev_v = align_closed(b.ct - look, ot_, ov)
            prev_t = align_closed(b.ct - look, ot_, ot_.astype("float64"))
            fresh = (b.ct - now_t <= 2 * HOUR_MS) & ((b.ct - look) - prev_t <= 2 * HOUR_MS)
            px_prev = align_closed(b.ct - look, b.ct, b.c)
            with np.errstate(invalid="ignore", divide="ignore"):
                d_oi = np.where(fresh, now_v / prev_v - 1.0, np.nan)
                d_px = b.c / px_prev - 1.0
                purge_l = (d_oi <= -float(p["oi_drop"])) & (d_px <= -float(p["price_move"]))
                purge_s = (d_oi <= -float(p["oi_drop"])) & (d_px >= float(p["price_move"]))
            for d, cond in ((1, purge_l), (-1, purge_s)):
                edge = cond.copy()
                edge[1:] &= ~cond[:-1]
                for j in np.nonzero(edge)[0]:
                    cand.append((int(j), d, f"purge de levier : OI {d_oi[j]:+.1%} et prix {d_px[j]:+.1%} sur 24 h"))
        for j, d, why in cand:
            if not ok[j] or not direction_allowed(p["direction"], d):
                continue
            out.append(Signal(
                symbol=sym, direction=Direction(d), concept=CONCEPT, variant=vid, tf_signal=tf, tf_context=None,
                generated_at=int(b.ct[j]), entry=float(b.c[j]), order_type="market",
                stop=float(b.c[j] - d * stop_atr * a[j]), exit_rule=rule, stop_offset=float(stop_atr * a[j]),
                atr=float(a[j]), reasons=(why,), invalidation=f"stop {stop_atr} ATR, objectif {p['tp_r']} R, 48 h maximum"))
    return out
