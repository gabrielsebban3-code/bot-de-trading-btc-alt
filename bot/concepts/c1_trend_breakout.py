"""C1 - Trend / breakout (Step 3), rules frozen in PROTOCOLE_PHASE2.md section 3.

Long: bullish regime (context timeframe) and close above the highest high of the N previous candles of the
signal timeframe (N in 20 / 55 / 100) or, for the ensemble, Donchian score >= 2/3 with a fresh 20-candle break.
Stop 2.5 ATR from the fill, trailing exit (chandelier 3 ATR or opposite Donchian 20), no fixed target.
"""
from __future__ import annotations

import numpy as np

from ..confluence.mtf import regime_at
from ..core.types import Direction, ExitKind, ExitRule, Signal
from .base import SymbolData, direction_allowed, merged_params, variant_id

CONCEPT = "C1"


def ensemble_score(sd_bars, ns: list[int]) -> np.ndarray:
    """Mean of the Donchian states (+1 after a close above the channel, -1 below, unchanged otherwise)."""
    states = []
    for n in ns:
        hi, lo = sd_bars.donchian(n)
        with np.errstate(invalid="ignore"):
            raw = np.where(sd_bars.c > hi, 1.0, np.where(sd_bars.c < lo, -1.0, np.nan))
        raw[0] = 0.0 if np.isnan(raw[0]) else raw[0]
        # forward fill the last state
        idx = np.where(~np.isnan(raw), np.arange(len(raw)), 0)
        idx = np.maximum.accumulate(idx)
        states.append(raw[idx])
    return np.mean(states, axis=0)


def generate_signals(data: dict[str, SymbolData], cfg: dict, params: dict) -> list[Signal]:
    """params: tf, entry_n ('20'|'55'|'100'|'ensemble'), trail ('chandelier'|'donchian'), direction,
    optional volume_filter (bool) and numeric overrides of config.yaml (robustness checks)."""
    p = merged_params(cfg, "c1", params)
    tf = p["tf"]
    vid = variant_id(CONCEPT, params)
    warm = int(cfg["engine"]["warmup_days"])
    if p["trail"] == "chandelier":
        rule = ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=float(p["trail_chandelier_atr"]), tf=tf)
    else:
        rule = ExitRule(ExitKind.TRAIL_DONCHIAN, donchian_n=int(round(float(p["trail_donchian_n"]))), tf=tf)
    out: list[Signal] = []
    for sym, sd in data.items():
        b = sd.bars[tf]
        if b.n == 0:
            continue
        a = b.atr(14)
        reg = regime_at(sd, tf, b.ct, p)
        ok = b.valid(warm, float(p["min_signal_volume"])) & np.isfinite(a)
        if p["entry_n"] == "ensemble":
            ns = [int(n) for n in p["donchian_ns"]]
            score = ensemble_score(b, ns)
            hi_f, lo_f = b.donchian(min(ns))
            with np.errstate(invalid="ignore"):
                long_c = (score >= float(p["ensemble_threshold"])) & (b.c > hi_f)
                short_c = (score <= -float(p["ensemble_threshold"])) & (b.c < lo_f)
        else:
            n = int(round(float(p["entry_n"])))
            hi, lo = b.donchian(n)
            with np.errstate(invalid="ignore"):
                long_c, short_c = b.c > hi, b.c < lo
        if p.get("volume_filter"):
            vm = b.vol_mean_prev(int(p["volume_window"]))
            with np.errstate(invalid="ignore", divide="ignore"):
                vok = b.v > float(p["volume_rel_min"]) * vm
            long_c, short_c = long_c & vok, short_c & vok
        stop_atr = float(p["stop_atr"])
        for d, cond, need in ((1, long_c, 1), (-1, short_c, -1)):
            if not direction_allowed(p["direction"], d):
                continue
            for t in np.nonzero(cond & ok & (reg == need))[0]:
                label = "ensemble" if p["entry_n"] == "ensemble" else f"Donchian {p['entry_n']}"
                out.append(Signal(
                    symbol=sym, direction=Direction(d), concept=CONCEPT, variant=vid, tf_signal=tf,
                    tf_context=p["context_tf"][tf], generated_at=int(b.ct[t]), entry=float(b.c[t]),
                    order_type="market", stop=float(b.c[t] - d * stop_atr * a[t]), exit_rule=rule,
                    stop_offset=float(stop_atr * a[t]), atr=float(a[t]), score=0.0,
                    reasons=(f"régime {'haussier' if d > 0 else 'baissier'} ({p['context_tf'][tf]})",
                             f"clôture au-delà du canal {label}"),
                    invalidation=f"stop initial à {stop_atr} ATR touché"))
    return out
