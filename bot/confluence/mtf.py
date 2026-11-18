"""Multi-timeframe helpers (Step 5): trend regime of the context timeframe, read only once closed.

Regime at instant t (+1 bullish, -1 bearish, 0 none), from the last CLOSED context candle:
close above EMA fast and EMA slow, ADX > adx_min, and the momentum (return over ``momentum_days`` closed
daily candles) of the same sign.
"""
from __future__ import annotations

import numpy as np

from ..concepts.base import SymbolData
from ..data.resampler import align_closed


def regime_at(sd: SymbolData, signal_tf: str, t_ms: np.ndarray, p: dict) -> np.ndarray:
    ctx_tf = p["context_tf"][signal_tf]
    key = ("regime", ctx_tf, p["ema_fast"], p["ema_slow"], p["adx_period"], p["adx_min"], p["momentum_days"])
    # ablation "no ADX": adx_min = -1 makes the ADX condition always true once ADX exists

    def _ctx():
        cb = sd.bars[ctx_tf]
        ef, es, a = cb.ema(int(p["ema_fast"])), cb.ema(int(p["ema_slow"])), cb.adx(int(p["adx_period"]))
        with np.errstate(invalid="ignore"):
            up = (cb.c > ef) & (cb.c > es) & (a > float(p["adx_min"]))
            dn = (cb.c < ef) & (cb.c < es) & (a > float(p["adx_min"]))
        state = np.where(up, 1.0, np.where(dn, -1.0, 0.0))
        state[np.isnan(ef) | np.isnan(es) | np.isnan(a)] = np.nan
        db = sd.bars["1d"]
        n = int(round(float(p["momentum_days"])))
        mom = np.full(db.n, np.nan)
        if db.n > n:
            mom[n:] = db.c[n:] / db.c[:-n] - 1.0
        return cb.ct, state, db.ct, mom

    ct, state, dct, mom = sd.cached(key, _ctx)
    s = align_closed(t_ms, ct, state)
    m = align_closed(t_ms, dct, mom)
    out = np.zeros(len(t_ms), dtype="int8")
    if not p.get("use_momentum", True):          # ablation: momentum component removed
        m = np.where(np.isfinite(m), 0.0, np.nan)
        with np.errstate(invalid="ignore"):
            out[(s == 1.0) & np.isfinite(m)] = 1
            out[(s == -1.0) & np.isfinite(m)] = -1
        return out
    with np.errstate(invalid="ignore"):
        out[(s == 1.0) & (m > 0)] = 1
        out[(s == -1.0) & (m < 0)] = -1
    return out
