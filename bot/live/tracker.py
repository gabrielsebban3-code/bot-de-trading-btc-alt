"""Live tracking of virtual positions (Step 6 / Step 10) with the backtest engine itself.

Every scan replays all stored signals of a variant, in chronological order, through the same portfolio rules
and the same ``execute_signal`` as the backtest, on the candles closed so far. The status of each signal is a
pure function of the data: replaying twice gives the same answer (idempotent, no drift after a restart).
"""
from __future__ import annotations

import numpy as np

from ..backtest.engine import TRADE_COLS, Costs, SymbolMarket, execute_signal
from ..core.types import Signal
from ..risk.portfolio import Portfolio


def replay(signals: list[Signal], market: dict[str, SymbolMarket], cfg: dict, group_fn=None) -> dict[str, dict]:
    """signal id -> status dict (status, stop, entry/exit, r_multiple, stop_moves)."""
    risk = cfg["risk"]
    costs = Costs.from_config(cfg)
    pf = Portfolio(cfg, group_fn=group_fn)
    out: dict[str, dict] = {}
    for s in sorted(signals, key=lambda x: (x.generated_at, x.symbol)):
        t = s.generated_at
        pf.release(t)
        m = market.get(s.symbol)
        if m is None or len(m.ot) == 0:
            out[s.id] = {"status": "en attente"}
            continue
        if t >= int(m.ot[-1]) + m.step:
            out[s.id] = {"status": "en attente", "stop": s.stop}     # next candle not closed yet
            continue
        why = pf.refuse_reason(s, t)
        if why:
            out[s.id] = {"status": "invalidé", "reason": f"portefeuille : {why}"}
            continue
        res = execute_signal(m, s, pf.capital, costs, risk, len(m.ot) - 1, live=True)
        if res.status == "pending":
            out[s.id] = {"status": "en attente", "stop": s.stop}
            pf.occupy(s, int(m.ot[-1]) + 10 ** 12)
        elif res.status == "open":
            pos = res.position
            moved = bool(pos.stop_moves)
            out[s.id] = {"status": "stop remonté" if moved else "actif", "stop": pos.stop,
                         "entry_time": res.entry_ms, "entry_price": res.entry_price,
                         "stop_moves": list(pos.stop_moves)}
            pf.occupy(s, int(m.ot[-1]) + 10 ** 12)          # still open: busy beyond now
        elif res.status == "trade":
            row = dict(zip(TRADE_COLS, res.row))
            r = float(row["r_multiple"])
            out[s.id] = {"status": "sorti en gain" if r > 0 else "sorti en perte", "entry_time": int(row["entry_time"]),
                         "entry_price": float(row["entry_price"]), "stop": float(row["initial_stop"]),
                         "exit_time": int(row["exit_time"]), "exit_price": float(row["exit_price"]),
                         "exit_reason": row["exit_reason"], "r_multiple": r}
            pf.open(s, res.exit_ms, res.pnl)
        elif res.status == "limit_expired":
            out[s.id] = {"status": "expiré"}
            pf.occupy(s, res.busy_until)
        else:
            out[s.id] = {"status": "invalidé", "reason": res.status}
            if res.busy_until is not None:
                pf.occupy(s, res.busy_until)
    return out
