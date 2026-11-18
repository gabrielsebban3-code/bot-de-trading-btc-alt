"""Random-entry baseline (Step 7, criterion 5 of PROTOCOLE.md).

For every real out-of-sample trade, random entries are drawn on the same symbol, inside the same test window,
with the same allowed direction, the same stop distance in ATR of the signal timeframe, the same exit rule and
the same costs. The distribution of the mean R of N random trades is compared with the real mean R.
It separates the value of the entry signal from the value of the exit (a trailing stop alone can look good).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.types import Direction, ExitKind, ExitRule, Signal
from .engine import TRADE_COLS, Costs, execute_signal


def random_baseline(trades: pd.DataFrame, signals_meta: dict[str, Signal], market: dict, data: dict, cfg: dict,
                    windows: dict[int, tuple[int, int]], direction_mode: str, rng: np.random.Generator) -> dict:
    """``signals_meta[signal_id]`` = the real signal (exit rule, timeframe); ``windows[fold]`` = (start, end)."""
    b = cfg["baseline"]
    n = len(trades)
    if n == 0:
        return {"n": 0, "median": np.nan, "p95": np.nan, "percentile": np.nan, "pool": 0}
    pool_size = max(int(b["pool_min"]), int(b["pool_per_trade"]) * n)
    costs = Costs.from_config(cfg)
    risk = cfg["risk"]
    warm = int(cfg["engine"]["warmup_days"])
    rows = trades.reset_index(drop=True)
    eligible_cache: dict = {}
    out = []
    attempts = 0
    while len(out) < pool_size and attempts < pool_size * 20:
        attempts += 1
        i = int(rng.integers(0, n))
        tr = rows.iloc[i]
        s0 = signals_meta[tr["signal_id"]]
        sym, tf = tr["symbol"], s0.tf_signal
        start, end = windows[int(tr["fold"])]
        key = (sym, tf, start, end)
        if key not in eligible_cache:
            bars = data[sym].bars[tf]
            ok = bars.valid(warm) & (bars.ot >= start) & (bars.ot < end)
            ok[0] = False
            eligible_cache[key] = np.nonzero(ok)[0]
        el = eligible_cache[key]
        if len(el) == 0 or not np.isfinite(tr["stop_atr"]):
            continue
        bars = data[sym].bars[tf]
        k = int(el[int(rng.integers(0, len(el)))])
        a = bars.atr(14)[k - 1]
        if not np.isfinite(a) or a <= 0:
            continue
        if direction_mode == "both":
            d = 1 if rng.random() < 0.5 else -1
        else:
            d = 1 if direction_mode == "long" else -1
        t = int(bars.ot[k])
        rule = s0.exit_rule
        if rule.kind == ExitKind.MEAN and rule.tp_price is not None and np.isfinite(s0.atr) and s0.atr > 0:
            # a fixed price target is converted into its distance in ATR at the signal (same relative target)
            tp_atr = abs(rule.tp_price - s0.entry) / s0.atr
            rule = ExitRule(ExitKind.MEAN, tp_price=float(bars.o[k] + d * tp_atr * a),
                            max_hold_bars=rule.max_hold_bars, tf=rule.tf)
        sig = Signal(symbol=sym, direction=Direction(d), concept="RANDOM", variant="random", tf_signal=tf,
                     tf_context=None, generated_at=t, entry=float(bars.o[k]), order_type="market",
                     stop=float(bars.o[k] - d * tr["stop_atr"] * a), exit_rule=rule,
                     stop_offset=float(tr["stop_atr"] * a), atr=float(a))
        m = market[sym]
        j_last = int(np.searchsorted(m.ot, end)) - 1
        res = execute_signal(m, sig, float(risk["initial_capital"]), costs, risk, j_last)
        if res.status == "trade":
            out.append(res.row[TRADE_COLS.index("r_multiple")])
    pool = np.asarray(out)
    if len(pool) == 0:
        return {"n": n, "median": np.nan, "p95": np.nan, "percentile": np.nan, "pool": 0}
    draws = int(b["draws"])
    means = pool[rng.integers(0, len(pool), size=(draws, n))].mean(axis=1)
    real = float(trades["r_multiple"].mean())
    return {"n": n, "pool": int(len(pool)), "median": float(np.median(means)),
            "p95": float(np.percentile(means, float(b["percentile"]))),
            "percentile": float(100.0 * (means < real).mean()), "pool_mean": float(pool.mean())}
