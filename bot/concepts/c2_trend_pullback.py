"""C2 - Pullback in the trend (Step 3), rules frozen in PROTOCOLE_PHASE2.md section 4.

1. Pullback on the signal timeframe, in a bullish regime: low touches EMA 20 / EMA 50, or comes within
   ±0.5 ATR of the last confirmed swing low ('structure'). An episode = consecutive touching candles; it stays
   armed until ``pullback_window`` signal candles after its last touch.
2. Resumption on the trigger timeframe: bullish BOS/CHoCH (close above the last confirmed swing high), closed
   after the pullback is known, while armed and while the regime is still bullish. One signal per episode.
3. Stop: last confirmed swing low of the trigger timeframe - 0.5 ATR(trigger). Exit: chandelier 3 ATR (signal tf).
Shorts are symmetric. Never against the context regime.
"""
from __future__ import annotations

import numpy as np

from ..confluence.mtf import regime_at
from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..data.resampler import align_closed
from ..structure.pivots import last_confirmed
from .base import SymbolData, direction_allowed, merged_params, variant_id

CONCEPT = "C2"


def _structure_cfg(cfg: dict, p: dict) -> dict:
    s = dict(cfg["structure"])
    if "fractal_n" in p:
        s["fractal_n"] = int(round(float(p["fractal_n"])))
    if "zigzag_atr_mult" in p:
        s["zigzag_atr_mult"] = float(p["zigzag_atr_mult"])
    return s


def _levels(b, method: str, scfg: dict, level: str) -> tuple[np.ndarray, np.ndarray]:
    piv = b.pivots(method, scfg)
    lvl = level if method == "hierarchical" else None
    hi, _ = last_confirmed(b.n, piv, 1, lvl)
    lo, _ = last_confirmed(b.n, piv, -1, lvl)
    return hi, lo


def generate_signals(data: dict[str, SymbolData], cfg: dict, params: dict) -> list[Signal]:
    """params: tf, pullback ('ema20'|'ema50'|'structure'), pivots ('fractal'|'zigzag'|'hierarchical'),
    direction, optional numeric overrides (robustness)."""
    p = merged_params(cfg, "c2", params)
    tf = p["tf"]
    ttf = p["trigger_tf"][tf]
    vid = variant_id(CONCEPT, params)
    warm = int(cfg["engine"]["warmup_days"])
    scfg = _structure_cfg(cfg, p)
    level = p["hierarchical_level"]
    rule = ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=float(p["trail_chandelier_atr"]), tf=tf)
    window = int(round(float(p["pullback_window"])))
    out: list[Signal] = []
    for sym, sd in data.items():
        b, tb = sd.bars[tf], sd.bars[ttf]
        if b.n == 0 or tb.n == 0:
            continue
        a = b.atr(14)
        reg_s = regime_at(sd, tf, b.ct, p)
        ok_s = b.valid(warm, float(p["min_signal_volume"])) & np.isfinite(a)
        # ---- pullback touches on the signal timeframe
        if p["pullback"].startswith("ema"):
            period = int(round(float(p.get("ema_period", p["pullback"][3:]))))
            e = b.ema(period)
            with np.errstate(invalid="ignore"):
                touch_long, touch_short = b.l <= e, b.h >= e
        else:
            s_hi, s_lo = _levels(b, p["pivots"], scfg, level)
            z = float(p["zone_atr"]) * a
            with np.errstate(invalid="ignore"):
                touch_long = (b.l <= s_lo + z) & (b.l >= s_lo - z)
                touch_short = (b.h >= s_hi - z) & (b.h <= s_hi + z)
        # ---- trigger timeframe: structure breaks, stops, regime at the trigger close
        ta = tb.atr(14)
        ev = tb.events(p["pivots"], scfg, level)
        t_hi, t_lo = _levels(tb, p["pivots"], scfg, level)
        ok_t = tb.valid(warm, float(p["min_signal_volume"])) & np.isfinite(ta)
        reg_t = regime_at(sd, tf, tb.ct, p)
        atr_s_at_t = align_closed(tb.ct, b.ct, a)
        buf = float(p["stop_buffer_atr"])
        for d, touch in ((1, touch_long), (-1, touch_short)):
            if not direction_allowed(p["direction"], d):
                continue
            pb = touch & ok_s & (reg_s == d)
            idx = np.nonzero(pb)[0]
            if len(idx) == 0:
                continue
            episode = np.cumsum(np.concatenate(([1], (np.diff(idx) > 1).astype(int))))
            pb_ct = b.ct[idx]
            used: set[int] = set()
            ev_d = ev[ev["direction"] == d]
            for j in ev_d["idx"].to_numpy():
                tct = tb.ct[j]
                k = int(np.searchsorted(pb_ct, tct, side="right")) - 1
                if k < 0 or tct > pb_ct[k] + window * b.step or episode[k] in used:
                    continue
                if not ok_t[j] or reg_t[j] != d:
                    continue
                swing = t_lo[j] if d > 0 else t_hi[j]
                if not np.isfinite(swing):
                    continue
                stop = swing - d * buf * ta[j]
                if (tb.c[j] - stop) * d <= 0:
                    continue
                used.add(episode[k])
                out.append(Signal(
                    symbol=sym, direction=Direction(d), concept=CONCEPT, variant=vid, tf_signal=tf,
                    tf_context=p["context_tf"][tf], generated_at=int(tct), entry=float(tb.c[j]),
                    order_type="market", stop=float(stop), exit_rule=rule, atr=float(atr_s_at_t[j]),
                    reasons=(f"régime {'haussier' if d > 0 else 'baissier'} ({p['context_tf'][tf]})",
                             f"repli {p['pullback']} sur {tf}", f"cassure de structure sur {ttf} ({p['pivots']})"),
                    invalidation=f"clôture au-delà du dernier swing {ttf} (stop {stop:.6g})"))
    return out
