"""Walk-forward validation (Step 7.1), rules frozen in PROTOCOLE_PHASE2.md section 5.

Each fold: the variant with the best expectancy (R) over the 24 training months, among variants with at least
``min_train_trades`` trades, is simulated on the next (unseen) 6 months. Capital is chained across folds.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..core.timeutil import to_ms


def folds(cfg: dict) -> list[tuple[int, int, int]]:
    """[(train_start, test_start, test_end)] in epoch ms."""
    wf = cfg["walk_forward"]
    start, end = pd.Timestamp(wf["start"]), pd.Timestamp(wf["end"])
    out = []
    t = start
    while t < end:
        nxt = min(t + pd.DateOffset(months=int(wf["test_months"])), end)
        out.append((to_ms(t - pd.DateOffset(months=int(wf["train_months"]))), to_ms(t), to_ms(nxt)))
        t = nxt
    return out


@dataclass
class Selection:
    fold: int
    test_start: int
    test_end: int
    variant: str | None
    train_trades: int
    train_expectancy: float


def select(full_trades: dict[str, pd.DataFrame], train_start: int, train_end: int, min_trades: int) -> tuple[str | None, int, float]:
    """Best training expectancy among variants with enough trades (ties: more trades, then name).

    Uses only trades whose exit is strictly before ``train_end``."""
    best = None
    for vid, tr in full_trades.items():
        # only trades ENTERED AND CLOSED inside the training window: a trade still open at the end of the training
        # window would carry prices of the test window into the selection (lookahead, DECISIONS D26)
        w = tr[(tr["entry_time"] >= train_start) & (tr["exit_time"] < train_end)]
        n = len(w)
        if n < min_trades:
            continue
        e = float(w["r_multiple"].mean())
        key = (e, n, vid)
        if best is None or key > best[0]:
            best = (key, vid, n, e)
    if best is None:
        return None, 0, float("nan")
    return best[1], best[2], best[3]


def walk_forward(run_fn, full_trades: dict[str, pd.DataFrame], cfg: dict) -> tuple[pd.DataFrame, list[Selection]]:
    """``run_fn(variant_id, start, end, initial_capital) -> (trades, info)``. Returns OOS trades and selections."""
    capital = float(cfg["risk"]["initial_capital"])
    parts, sels = [], []
    for k, (a, b, c) in enumerate(folds(cfg)):
        vid, n, e = select(full_trades, a, b, int(cfg["walk_forward"]["min_train_trades"]))
        sels.append(Selection(k, b, c, vid, n, e))
        if vid is None:
            continue
        tr, info = run_fn(vid, b, c, capital)
        if len(tr):
            tr = tr.assign(fold=k)
            parts.append(tr)
        capital = info["final_capital"]
    oos = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
    return oos, sels
