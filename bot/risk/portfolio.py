"""Portfolio constraints of the simulation (Step 8), shared by the backtest and the live scanner.

* one position per pair (configurable), at most ``max_positions`` at once;
* at most ``max_same_direction`` positions in the same direction inside a correlation group
  (e.g. altcoins whose 30-day correlation with BTC exceeds the threshold);
* no new entry for the rest of the UTC day once realised losses of the day reach ``max_daily_loss_pct``;
* capital = initial capital + PnL of positions CLOSED strictly before the decision time.
"""
from __future__ import annotations

import heapq
from typing import Callable

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS
from ..core.types import Signal


class Portfolio:
    def __init__(self, cfg: dict, group_fn: Callable[[str, int], str | None] | None = None):
        r = cfg["risk"]
        self.max_positions = int(r["max_positions"])
        self.max_per_pair = int(r["max_positions_per_pair"])
        self.max_daily_loss = r.get("max_daily_loss_pct")
        corr = r.get("correlation") or {}
        self.max_same_dir = int(corr.get("max_same_direction", 10 ** 9)) if corr.get("enabled") else None
        self.group_fn = group_fn if corr.get("enabled") else None
        self.capital = float(r["initial_capital"])
        self._pending: list[tuple[int, int, float]] = []      # (exit ms, seq, pnl)
        self._realised: list[tuple[int, float]] = []          # applied exits (exit ms, pnl)
        self._slots: list[tuple[int, str, int, str | None]] = []  # (busy until, symbol, direction, group)
        self._seq = 0

    def release(self, t: int) -> None:
        """Apply exits strictly before ``t`` (a slot freed during candle t is usable from its close)."""
        while self._pending and self._pending[0][0] < t:
            ms, _, pnl = heapq.heappop(self._pending)
            self.capital += pnl
            self._realised.append((ms, pnl))
        self._slots = [x for x in self._slots if x[0] >= t]

    def _day_loss_reached(self, t: int) -> bool:
        if not self.max_daily_loss:
            return False
        day0 = (t // DAY_MS) * DAY_MS
        today = sum(p for ms, p in self._realised if ms >= day0)
        start_cap = self.capital - today
        return start_cap > 0 and today <= -float(self.max_daily_loss) * start_cap

    def refuse_reason(self, s: Signal, t: int) -> str | None:
        if self.capital <= 0:
            return "no_capital"
        if sum(1 for x in self._slots if x[1] == s.symbol) >= self.max_per_pair:
            return "pair_busy"
        if len(self._slots) >= self.max_positions:
            return "portfolio_full"
        if self._day_loss_reached(t):
            return "daily_loss"
        if self.group_fn is not None and self.max_same_dir is not None:
            g = self.group_fn(s.symbol, t)
            if g is not None:
                same = sum(1 for x in self._slots if x[3] == g and x[2] == int(s.direction))
                if same >= self.max_same_dir:
                    return "correlated"
        return None

    def occupy(self, s: Signal, until_ms: int) -> None:
        g = self.group_fn(s.symbol, s.generated_at) if self.group_fn else None
        self._slots.append((until_ms, s.symbol, int(s.direction), g))

    def open(self, s: Signal, exit_ms: int, pnl: float) -> None:
        self.occupy(s, exit_ms)
        heapq.heappush(self._pending, (exit_ms, self._seq, pnl))
        self._seq += 1


class CorrelationGroups:
    """Group "btc_beta" = symbols whose correlation of daily returns with BTC over the last ``window_days``
    COMPLETED days is at least ``threshold``. Other symbols have no group."""

    def __init__(self, daily_closes: dict[str, pd.DataFrame], cfg: dict, reference: str = "BTCUSDT"):
        c = cfg["risk"]["correlation"]
        self.window = int(c["window_days"])
        self.threshold = float(c["threshold"])
        self.reference = reference
        self._table: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        ref = daily_closes.get(reference)
        if ref is None:
            return
        ref_r = pd.Series(np.log(ref["close"].to_numpy()), index=ref["open_time"].to_numpy()).diff()
        for sym, df in daily_closes.items():
            r = pd.Series(np.log(df["close"].to_numpy()), index=df["open_time"].to_numpy()).diff()
            j = pd.concat([r, ref_r], axis=1, join="inner").dropna()
            corr = j.iloc[:, 0].rolling(self.window).corr(j.iloc[:, 1])
            # known at the close of the day: usable from open_time + 1 day
            self._table[sym] = (j.index.to_numpy(dtype="int64") + DAY_MS, corr.to_numpy())

    def group(self, symbol: str, t: int) -> str | None:
        if symbol == self.reference:
            return "btc_beta"
        tab = self._table.get(symbol)
        if tab is None:
            return None
        k = int(np.searchsorted(tab[0], t, side="right")) - 1
        if k < 0 or not np.isfinite(tab[1][k]):
            return None
        return "btc_beta" if tab[1][k] >= self.threshold else None
