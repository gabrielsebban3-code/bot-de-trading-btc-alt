"""Engine regression test against perp-setups study 1 (configuration ``C_tf4h_dc55_volon`` on DEV).

This is NOT a concept of the tournament: it reproduces a strategy whose result is already known
(455 trades, +0.2228 R, PF 1.497, win rate 39.56 %, max drawdown 18.82 % on 2020-01-01 -> 2022-12-31)
to check that the new engine, resampler and indicators give the same numbers under the same hypotheses:
Donchian 55 on 4h (close above the high of the 55 previous candles, volume > 1.5 x mean of the 20
previous), market entry at the next open, stop 2 ATR from the fill, chandelier 3 ATR, 1 % risk,
5 positions, one per pair, fixed slippage 0.03 %, funding on the entry notional, no trend filter.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.config import load_config
from ..core.timeutil import DAY_MS, to_ms
from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..data.resampler import resample
from ..data.storage import MarketStore
from ..indicators._core import rolling_prev
from ..indicators.trend import donchian
from ..indicators.volatility import atr as atr_fn
from .engine import SymbolMarket, run_backtest
from .metrics import compute_metrics

STUDY1_PAIRS = ["BTCUSDT", "ETHUSDT", "ZECUSDT", "SOLUSDT", "XRPUSDT", "NEARUSDT", "DOGEUSDT", "BNBUSDT",
                "1000PEPEUSDT", "ENAUSDT", "SUIUSDT", "UNIUSDT", "WLDUSDT", "TRUMPUSDT", "ADAUSDT", "LINKUSDT",
                "QNTUSDT", "AVAXUSDT", "TAOUSDT", "ARBUSDT"]
EXPECTED = {"n_trades": 455, "expectancy_r": 0.222814, "profit_factor": 1.49699, "win_rate": 0.395604,
            "max_dd_pct": 18.8196}

OVERLAY = {
    "costs": {"slippage": {"base": 0.0003, "atr_coef": 0.0, "impact_coef": 0.0}, "funding_price": "entry"},
    "risk": {"max_daily_loss_pct": None, "correlation": {"enabled": False}, "max_stop_pct": 0.06, "min_stop_pct": 0.003},
}


def study1_signals(symbol: str, bars4h: pd.DataFrame, warmup_days: int = 30) -> list[Signal]:
    h, l, c, v = (bars4h[k].to_numpy(dtype="float64") for k in ("high", "low", "close", "volume"))
    ot = bars4h["open_time"].to_numpy(dtype="int64")
    ct = bars4h["close_time"].to_numpy(dtype="int64")
    contig = bars4h["contig"].to_numpy(dtype=bool)
    a = atr_fn(h, l, c, 14)
    hi, lo = donchian(h, l, 55)
    vol_ok = v > 1.5 * rolling_prev(v, 20, "mean")
    brk = np.where(~contig, ot, np.int64(-1))
    if len(brk):
        brk[0] = ot[0]
    valid = (ot - np.maximum.accumulate(brk)) >= warmup_days * DAY_MS
    rule = ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=3.0, tf="4h")
    out = []
    with np.errstate(invalid="ignore"):
        for d, cond in ((1, c > hi), (-1, c < lo)):
            for t in np.nonzero(cond & vol_ok & valid & np.isfinite(a))[0]:
                out.append(Signal(symbol=symbol, direction=Direction(d), concept="REF", variant="study1_C_tf4h_dc55_volon",
                                  tf_signal="4h", tf_context=None, generated_at=int(ct[t]), entry=float(c[t]),
                                  order_type="market", stop=float(c[t] - d * 2.0 * a[t]), exit_rule=rule,
                                  stop_offset=float(2.0 * a[t]), atr=float(a[t])))
    return out


def run_regression(cfg: dict | None = None, store: MarketStore | None = None,
                   start: str = "2020-01-01", end: str = "2023-01-01") -> dict:
    import copy
    from ..core.config import _deep_update
    cfg = load_config(overlay=OVERLAY) if cfg is None else _deep_update(copy.deepcopy(cfg), OVERLAY)
    store = store or MarketStore(cfg)
    s_ms, e_ms = to_ms(start), to_ms(end)
    market, signals, missing = {}, [], []
    for sym in STUDY1_PAIRS:
        df = store.candles(sym, "15m", s_ms, e_ms)
        if df.empty:
            missing.append(sym)
            continue
        fund = store.funding(sym, s_ms, e_ms)
        m = SymbolMarket(sym, df, "15m", fund, None, cfg)
        b4 = resample(df, "15m", "4h")
        m.add_tf("4h", b4)
        market[sym] = m
        signals += study1_signals(sym, b4)
    trades, info = run_backtest(signals, market, cfg, s_ms, e_ms)
    met = compute_metrics(trades, cfg["risk"]["initial_capital"], s_ms, e_ms, n_boot=200)
    got = {k: met[k] for k in EXPECTED}
    return {"expected": EXPECTED, "got": got, "missing_pairs": missing, "info": info}
