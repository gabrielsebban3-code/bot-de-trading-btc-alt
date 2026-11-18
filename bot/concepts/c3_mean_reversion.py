"""C3 - Bounded mean reversion (Step 3), rules frozen in PROTOCOLE_PHASE3.md section 2.

Long only when the context close is above its EMA 200 (background trend), RSI(p) <= 10 and the close is far
below the mean (under the lower Bollinger band, or 1.5 ATR under the rolling 20-candle VWAP). Target: SMA 20 of
the signal candle (fixed at entry), stop 1.5 ATR, time exit after 10 candles. Shorts symmetric.
"""
from __future__ import annotations

import numpy as np

from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..data.resampler import align_closed
from ..indicators.momentum import rsi
from ..indicators.volatility import bollinger
from .base import SymbolData, direction_allowed, merged_params, variant_id

CONCEPT = "C3"


def rolling_vwap(b, window: int) -> np.ndarray:
    tp = (b.h + b.l + b.c) / 3.0
    pv = np.cumsum(np.insert(tp * b.v, 0, 0.0))
    vv = np.cumsum(np.insert(b.v, 0, 0.0))
    out = np.full(b.n, np.nan)
    if b.n >= window:
        num = pv[window:] - pv[:-window]
        den = vv[window:] - vv[:-window]
        with np.errstate(invalid="ignore", divide="ignore"):
            out[window - 1:] = np.where(den > 0, num / den, np.nan)
    return out


def generate_signals(data: dict[str, SymbolData], cfg: dict, params: dict) -> list[Signal]:
    """params: tf, rsi_period, deviation ('bb'|'vwap'), direction (default 'both'), numeric overrides."""
    params = dict(params)
    params.setdefault("direction", "both")
    p = merged_params(cfg, "c3", params)
    tf = p["tf"]
    vid = variant_id(CONCEPT, params)
    warm = int(cfg["engine"]["warmup_days"])
    period = int(round(float(p["rsi_period"])))
    hold = int(round(float(p["max_hold_bars"])))
    out: list[Signal] = []
    for sym, sd in data.items():
        b = sd.bars[tf]
        if b.n == 0:
            continue
        cb = sd.bars[p["context_tf"][tf]]
        trend_ema = int(round(float(p["trend_ema"])))
        ctx_c = align_closed(b.ct, cb.ct, cb.c)
        ctx_e = align_closed(b.ct, cb.ct, cb.ema(trend_ema))
        a = b.atr(14)
        r = b.cached(("rsi", period), lambda: rsi(b.c, period))
        bbp = int(round(float(p["bb_period"])))
        mid, up, lo = b.cached(("bb", bbp, float(p["bb_k"])), lambda: bollinger(b.c, bbp, float(p["bb_k"])))
        ok = b.valid(warm, float(p["min_signal_volume"])) & np.isfinite(a) & np.isfinite(mid)
        with np.errstate(invalid="ignore"):
            trend_up, trend_dn = ctx_c > ctx_e, ctx_c < ctx_e
            if p["deviation"] == "bb":
                far_dn, far_up = b.c < lo, b.c > up
            else:
                vw = b.cached(("rvwap", int(p["vwap_window"])), lambda: rolling_vwap(b, int(p["vwap_window"])))
                far_dn = b.c <= vw - float(p["vwap_atr"]) * a
                far_up = b.c >= vw + float(p["vwap_atr"]) * a
            long_c = trend_up & (r <= float(p["rsi_low"])) & far_dn & (mid > b.c)
            short_c = trend_dn & (r >= float(p["rsi_high"])) & far_up & (mid < b.c)
        stop_atr = float(p["stop_atr"])
        for d, cond in ((1, long_c), (-1, short_c)):
            if not direction_allowed(p["direction"], d):
                continue
            for t in np.nonzero(cond & ok)[0]:
                rule = ExitRule(ExitKind.MEAN, tp_price=float(mid[t]), max_hold_bars=hold, tf=tf)
                out.append(Signal(
                    symbol=sym, direction=Direction(d), concept=CONCEPT, variant=vid, tf_signal=tf,
                    tf_context=p["context_tf"][tf], generated_at=int(b.ct[t]), entry=float(b.c[t]),
                    order_type="market", stop=float(b.c[t] - d * stop_atr * a[t]), exit_rule=rule,
                    stop_offset=float(stop_atr * a[t]), atr=float(a[t]),
                    reasons=(f"tendance de fond {'haussière' if d > 0 else 'baissière'} (EMA {trend_ema} {p['context_tf'][tf]})",
                             f"RSI({period}) {'≤ ' + str(p['rsi_low']) if d > 0 else '≥ ' + str(p['rsi_high'])}",
                             "clôture hors bande de Bollinger" if p["deviation"] == "bb" else "écart à la VWAP ≥ 1,5 ATR"),
                    invalidation=f"stop {stop_atr} ATR ou {hold} bougies sans retour à la moyenne"))
    return out
