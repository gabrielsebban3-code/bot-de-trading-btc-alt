"""C5 - SMC reversal (Step 3), unproven hypothesis tested without indulgence. Rules: PROTOCOLE_PHASE3.md section 2.

Sweep of an intact liquidity level (equal highs/lows of confirmed fractal pivots, or previous day / week high-low)
with a close back inside -> CHoCH in the opposite direction within 10 candles -> zone of the impulse (FVG or order
block) confirmed at the latest at the CHoCH -> limit order in the middle of the zone, valid 10 candles, filled only
if price trades through. Stop beyond the sweep extreme +- 0.25 ATR, target 2 R or 3 R.
Top/bottom score 0-100 by confluence (weights in config.yaml). Nothing here predicts a top: every element is known
only once confirmed, and the score is judged by the expectancy it produces.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..indicators._core import rolling_prev
from ..indicators.momentum import rsi
from ..structure.liquidity import equal_levels, period_levels, sweeps
from ..structure.market_structure import structure_events
from ..structure.zones import fvgs, order_blocks
from .base import SymbolData, merged_params, variant_id

CONCEPT = "C5"


def _setups(sd: SymbolData, tf: str, p: dict, scfg: dict) -> pd.DataFrame:
    """All sweep -> CHoCH -> zone sequences of one symbol (independent of tp / score threshold)."""
    b = sd.bars[tf]
    key = ("c5", tf, p["liquidity"], p["zone"], float(p["equal_tol"]), int(p["equal_lookback"]), int(p["choch_window"]),
           int(p["zone_lookback"]), int(p["pivot_n"]))
    if key in b._cache:
        return b._cache[key]
    s2 = dict(scfg, fractal_n=int(p["pivot_n"]))
    piv = b.pivots("fractal", s2)
    a = b.atr(14)
    ptf = p["period_tf"][tf]
    pb = sd.bars[ptf]
    per = period_levels(b.ot, pb.ct, pb.h, pb.l)
    if p["liquidity"] == "equal":
        levels = equal_levels(piv, float(p["equal_tol"]), int(p["equal_lookback"]))
    else:
        levels = per
    sw = sweeps(b.h, b.l, b.c, levels, p["liquidity"])
    ev, _ = structure_events(b.c, piv)
    ch = ev[ev["kind"] == "CHoCH"]
    zones = fvgs(b.h, b.l)
    if p["zone"] == "ob":
        zones = order_blocks(b.o, b.h, b.l, b.c, zones, ev)
    zc = zones["confirm_idx"].to_numpy() if len(zones) else np.zeros(0, dtype="int64")
    r = b.cached(("rsi", int(p["divergence_rsi"])), lambda: rsi(b.c, int(p["divergence_rsi"])))
    vmean = rolling_prev(b.v, 20, "mean")
    per_lv = per["level"].to_numpy() if len(per) else np.zeros(0)
    per_known = per["known_idx"].to_numpy() if len(per) else np.zeros(0, dtype="int64")
    w = p["weights"]
    rows = []
    ph = piv[piv["kind"] == 1].sort_values("confirm_idx")
    pl = piv[piv["kind"] == -1].sort_values("confirm_idx")
    for s, d, lvl in zip(sw["idx"].to_numpy(), sw["direction"].to_numpy(), sw["level"].to_numpy()):
        s, d = int(s), int(d)
        c_ok = ch[(ch["direction"] == d) & (ch["idx"] > s) & (ch["idx"] <= s + int(p["choch_window"]))]
        if c_ok.empty:
            continue
        c = int(c_ok["idx"].iloc[0])
        if len(zones) == 0:
            continue
        zsel = zones[(zones["direction"] == d) & (zc <= c) & (zones["origin_idx"].to_numpy() >= s - int(p["zone_lookback"]))]
        if zsel.empty:
            continue
        z = zsel.iloc[-1]
        mid = 0.5 * (float(z["bottom"]) + float(z["top"]))
        extreme = b.l[s] if d > 0 else b.h[s]
        stop = extreme - d * float(p["stop_atr"]) * a[c]
        if not np.isfinite(stop) or (mid - stop) * d <= 0 or (b.c[c] - mid) * d <= 0:
            continue                       # the limit must be passive (below the close for a long) and inside the stop
        # ---- top / bottom score
        score = float(w["sweep"])
        ref = (pl if d > 0 else ph)
        ref = ref[ref["confirm_idx"] < s]
        if len(ref):
            pi = int(ref["idx"].iloc[-1])
            if np.isfinite(r[s]) and np.isfinite(r[pi]):
                if (d > 0 and b.l[s] < b.l[pi] and r[s] > r[pi]) or (d < 0 and b.h[s] > b.h[pi] and r[s] < r[pi]):
                    score += float(w["divergence"])
        if np.isfinite(vmean[s]) and b.v[s] > float(p["climax_mult"]) * vmean[s]:
            score += float(w["climax"])
        known = per_lv[per_known < s]
        if p["liquidity"] == "period" or (len(known) and np.min(np.abs(known[-4:] - lvl)) <= float(p["htf_atr"]) * a[s]):
            score += float(w["htf_zone"])
        if c - s <= int(p["fast_choch_bars"]):
            score += float(w["fast_choch"])
        rows.append((s, c, d, float(lvl), mid, stop, float(a[c]), score))
    out = pd.DataFrame(rows, columns=["sweep_idx", "choch_idx", "direction", "level", "limit", "stop", "atr", "score"])
    b._cache[key] = out
    return out


def generate_signals(data: dict[str, SymbolData], cfg: dict, params: dict) -> list[Signal]:
    """params: tf, liquidity ('equal'|'period'), zone ('fvg'|'ob'), tp_r, min_score (direction: both)."""
    params = dict(params)
    params.setdefault("direction", "both")
    p = merged_params(cfg, "c5", params)
    tf = p["tf"]
    vid = variant_id(CONCEPT, params)
    warm = int(cfg["engine"]["warmup_days"])
    rule = ExitRule(ExitKind.TAKE_PROFIT, tp_r=float(p["tp_r"]), tf=tf)
    out: list[Signal] = []
    for sym, sd in data.items():
        b = sd.bars[tf]
        if b.n == 0:
            continue
        st = _setups(sd, tf, p, cfg["structure"])
        if st.empty:
            continue
        ok = b.valid(warm, float(p["min_signal_volume"]))
        for r in st.itertuples(index=False):
            if r.score < float(p["min_score"]) or not ok[r.choch_idx]:
                continue
            d = int(r.direction)
            if p["direction"] != "both" and (d > 0) != (p["direction"] == "long"):
                continue
            t = int(b.ct[r.choch_idx])
            out.append(Signal(
                symbol=sym, direction=Direction(d), concept=CONCEPT, variant=vid, tf_signal=tf, tf_context=None,
                generated_at=t, entry=float(r.limit), order_type="limit", stop=float(r.stop), exit_rule=rule,
                limit_expiry=t + int(p["limit_validity_bars"]) * b.step, atr=float(r.atr), score=float(r.score),
                reasons=(f"sweep du niveau {r.level:.6g} ({p['liquidity']})", f"CHoCH {r.choch_idx - r.sweep_idx} bougies plus tard",
                         f"retour dans la zone {p['zone'].upper()}"),
                invalidation="ordre annulé si non rempli en 10 bougies ou si le stop est touché",
                meta=(("delay_bars", float(r.choch_idx - r.sweep_idx)),)))
    return out
