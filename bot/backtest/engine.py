"""Event-driven backtest engine (Step 6). The live scanner uses the same ``Position`` object.

Execution rules (identical for every concept, no advantage to anyone):

* Signals are processed in chronological order of ``generated_at`` (close of the signal candle), ties by symbol.
* Market order: filled at the OPEN of the first path candle at ``generated_at`` (= next candle open),
  plus adverse slippage, taker fee. No such candle (data gap) -> signal skipped.
* Limit order: filled only if price trades THROUGH the level (a touch is not a fill) before expiry,
  at the limit price, maker fee. A take-profit cannot fill on the fill candle (unknown order); the stop can.
* Stop: triggered when a path candle reaches it, filled at the stop or at the open if the candle gapped
  beyond it, adverse slippage, taker fee.
* Take-profit: filled only if price trades THROUGH it, at the target (never better), maker fee.
* Stop and target in the same path candle: the stop wins (pessimistic).
* Trailing stops are recomputed at each CLOSE of a signal-timeframe candle, from closed candles only,
  and never move against the position. The new stop applies from the next candle.
* Funding: paid / received at every settlement during the holding period.
* A position meeting a data gap is cancelled (no invented price): no trade row, the slot stays busy until the gap.
* A position still open at the end of the window is closed at the close of the last candle (market).

Sizing: risk_per_trade x realised capital / R distance, capped by max_leverage (see ``risk.sizing``).
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS, bucket_start, tf_ms
from ..core.types import Direction, ExitKind, ExitRule, Signal
from ..data.resampler import align_closed
from ..indicators._core import rolling_incl
from ..indicators.volatility import atr as atr_fn
from ..risk.portfolio import Portfolio
from ..risk.sizing import position_size

TRADE_COLS = ["signal_id", "concept", "variant", "symbol", "direction", "tf", "signal_time", "entry_time",
              "entry_price", "initial_stop", "tp_price", "exit_time", "exit_price", "exit_reason", "size",
              "notional", "fees", "slippage_cost", "funding", "pnl", "r_multiple", "bars_held",
              "risk_pct", "stop_moves", "score", "stop_atr"]


# ---------------------------------------------------------------- costs

@dataclass(frozen=True)
class Costs:
    maker: float
    taker: float
    slip_base: float
    slip_atr: float
    slip_impact: float
    funding_price: str = "mark"       # "mark": price at settlement; "entry": entry price (study 1 convention)

    @staticmethod
    def from_config(cfg: dict, multiplier: float = 1.0) -> "Costs":
        c = cfg["costs"]
        s = c["slippage"]
        return Costs(c["maker_fee"] * multiplier, c["taker_fee"] * multiplier, s["base"] * multiplier,
                     s["atr_coef"] * multiplier, s["impact_coef"] * multiplier,
                     c.get("funding_price", "mark"))


# ---------------------------------------------------------------- market data of one symbol

class SymbolMarket:
    """Path candles (15m or 1m), signal-timeframe candles, funding and slippage inputs of one symbol."""

    def __init__(self, symbol: str, path: pd.DataFrame, path_tf: str, funding: pd.DataFrame | None,
                 daily: pd.DataFrame | None, cfg: dict):
        self.symbol = symbol
        self.path_tf = path_tf
        self.step = tf_ms(path_tf)
        self.ot = path["open_time"].to_numpy(dtype="int64")
        self.o = path["open"].to_numpy(dtype="float64")
        self.h = path["high"].to_numpy(dtype="float64")
        self.l = path["low"].to_numpy(dtype="float64")
        self.c = path["close"].to_numpy(dtype="float64")
        diff = np.diff(self.ot)
        self.gap_idx = np.nonzero(diff != self.step)[0].astype("int64")
        # funding
        if funding is not None and len(funding):
            self.f_time = (funding["time"].to_numpy(dtype="int64") // 60_000) * 60_000
            self.f_rate = funding["rate"].to_numpy(dtype="float64")
        else:
            self.f_time = np.zeros(0, dtype="int64")
            self.f_rate = np.zeros(0)
        # slippage inputs, causal: ATR of the previous path candle, ADV and daily vol of completed days
        sp = cfg["costs"]["slippage"]
        a = atr_fn(self.h, self.l, self.c, int(sp["atr_period"]))
        self.atr_frac_prev = np.full(len(self.ot), np.nan)
        if len(self.ot) > 1:
            with np.errstate(divide="ignore", invalid="ignore"):
                self.atr_frac_prev[1:] = a[:-1] / self.c[:-1]
        self.adv = np.full(len(self.ot), np.nan)
        self.dvol = np.full(len(self.ot), np.nan)
        if daily is not None and len(daily) > 2:
            dct = daily["open_time"].to_numpy(dtype="int64") + DAY_MS
            qv = rolling_incl(daily["quote_volume"].to_numpy(dtype="float64"), int(sp["adv_days"]), "mean")
            lr = np.full(len(daily), np.nan)
            lr[1:] = np.diff(np.log(daily["close"].to_numpy(dtype="float64")))
            vol = rolling_incl(lr, int(sp["vol_days"]), "std")
            self.adv = align_closed(self.ot, dct, qv)
            self.dvol = align_closed(self.ot, dct, vol)
        self.tf: dict[str, dict[str, np.ndarray]] = {}

    def add_tf(self, tf: str, bars: pd.DataFrame, atr_period: int = 14, donchian_ns: tuple[int, ...] = ()) -> None:
        h = bars["high"].to_numpy(dtype="float64")
        l = bars["low"].to_numpy(dtype="float64")
        c = bars["close"].to_numpy(dtype="float64")
        d = {"ot": bars["open_time"].to_numpy(dtype="int64"), "h": h, "l": l, "c": c,
             "atr": atr_fn(h, l, c, atr_period)}
        for n in donchian_ns:
            d[f"lo{n}"] = rolling_incl(l, n, "min")
            d[f"hi{n}"] = rolling_incl(h, n, "max")
        self.tf[tf] = d

    # ------------------------------------------------------------ helpers
    def index_at(self, t_ms: int) -> int:
        j = int(np.searchsorted(self.ot, t_ms))
        return j if j < len(self.ot) and self.ot[j] == t_ms else -1

    def next_gap(self, j: int) -> int:
        """Smallest index g >= j whose next candle is missing; len - 1 when none."""
        p = int(np.searchsorted(self.gap_idx, j))
        return int(self.gap_idx[p]) if p < len(self.gap_idx) else len(self.ot) - 1

    def slippage(self, j: int, notional: float, costs: Costs) -> float:
        frac = costs.slip_base
        a = self.atr_frac_prev[j] if 0 <= j < len(self.ot) else np.nan
        if costs.slip_atr and np.isfinite(a):
            frac += costs.slip_atr * a
        if costs.slip_impact and np.isfinite(self.adv[j]) and np.isfinite(self.dvol[j]) and self.adv[j] > 0:
            frac += costs.slip_impact * self.dvol[j] * np.sqrt(max(notional, 0.0) / self.adv[j])
        return float(frac)

    def funding_cost(self, direction: int, size: float, entry_price: float, j_entry: int, j_exit: int,
                     mode: str) -> float:
        """Funding paid (positive) or received (negative) for settlements f with ot[j_entry] < f <= ot[j_exit]."""
        a = int(np.searchsorted(self.f_time, self.ot[j_entry], side="right"))
        b = int(np.searchsorted(self.f_time, self.ot[j_exit], side="right"))
        if b <= a:
            return 0.0
        rates = self.f_rate[a:b]
        if mode == "entry":
            prices = np.full(len(rates), entry_price)
        else:
            k = np.searchsorted(self.ot, self.f_time[a:b], side="left")
            k = np.clip(k, 0, len(self.ot) - 1)
            prices = self.o[k]
        return float(direction * size * np.sum(rates * prices))


# ---------------------------------------------------------------- position (shared with live)

@dataclass
class Exit:
    j: int
    raw_price: float
    reason: str          # stop, trail, tp, time, end, liquidation


@dataclass
class Position:
    """An open virtual position. ``check`` and ``on_tf_close`` are the only state transitions."""
    direction: int
    entry_price: float
    initial_stop: float
    rule: ExitRule
    liq_price: float
    tp: float | None = None
    stop: float = field(init=False)
    ext: float = field(init=False)
    stop_moves: list = field(default_factory=list)

    def __post_init__(self) -> None:
        self.stop = self.initial_stop
        self.ext = -np.inf if self.direction > 0 else np.inf

    def check(self, o: np.ndarray, h: np.ndarray, l: np.ndarray, allow_tp_first: bool = True) -> tuple[int, float, str] | None:
        """First path candle of the slice hitting the stop or the target: (offset, raw price, reason)."""
        if len(o) == 0:
            return None
        d = self.direction
        s_hit = l <= self.stop if d > 0 else h >= self.stop
        if self.tp is not None:
            t_hit = h > self.tp if d > 0 else l < self.tp
            if not allow_tp_first:
                t_hit = t_hit.copy()
                t_hit[0] = False
            hit = s_hit | t_hit
        else:
            t_hit, hit = None, s_hit
        k = int(np.argmax(hit))
        if not hit[k]:
            return None
        if s_hit[k]:                                   # the stop wins when both are hit
            px = min(float(o[k]), self.stop) if d > 0 else max(float(o[k]), self.stop)
            if (d > 0 and px <= self.liq_price) or (d < 0 and px >= self.liq_price):
                return k, self.liq_price, "liquidation"
            return k, px, ("trail" if self.stop != self.initial_stop else "stop")
        return k, float(self.tp), "tp"

    def observe_path(self, h: np.ndarray, l: np.ndarray) -> None:
        """Track the extreme reached since entry (used by the chandelier stop)."""
        if len(h):
            self.ext = max(self.ext, float(h.max())) if self.direction > 0 else min(self.ext, float(l.min()))

    def on_tf_close(self, close_ms: int, atr: float, chan_lo: float = np.nan, chan_hi: float = np.nan) -> bool:
        """Recompute the trailing stop after a signal-timeframe candle closed. Returns True if it moved."""
        r = self.rule
        d = self.direction
        if r.kind == ExitKind.TRAIL_CHANDELIER and np.isfinite(atr):
            cand = self.ext - r.atr_mult * atr if d > 0 else self.ext + r.atr_mult * atr
        elif r.kind == ExitKind.TRAIL_DONCHIAN:
            cand = chan_lo if d > 0 else chan_hi
        else:
            return False
        if not np.isfinite(cand):
            return False
        new = max(self.stop, cand) if d > 0 else min(self.stop, cand)
        if new != self.stop:
            self.stop = new
            self.stop_moves.append((int(close_ms), float(new)))
            return True
        return False


def liquidation_price(entry_price: float, direction: int, risk: dict) -> float:
    dist = 1.0 / float(risk["max_leverage"]) - float(risk["maintenance_margin_rate"])
    return entry_price * (1.0 - direction * dist)


def simulate_position(m: SymbolMarket, pos: Position, j_entry: int, j_last: int, tf: str,
                      is_limit: bool, max_hold_path: int | None) -> Exit | None:
    """Walk the path candle by candle (vectorised inside each signal-timeframe candle).

    Returns None when a data gap is met before the exit (trade cancelled).
    """
    arr = m.tf[tf]
    step = tf_ms(tf)
    g = m.next_gap(j_entry)
    j_end = min(j_last, g)
    j_time = j_entry + max_hold_path if max_hold_path else None
    hi = j_end if j_time is None else min(j_end, j_time - 1)
    dn = pos.rule.donchian_n
    j = j_entry
    first = True
    while j <= hi:
        bar_open = int(bucket_start(int(m.ot[j]), tf))          # tf candle containing path candle j
        seg_end = int(np.searchsorted(m.ot, bar_open + step, side="left"))
        e = min(seg_end, hi + 1)
        res = pos.check(m.o[j:e], m.h[j:e], m.l[j:e], allow_tp_first=not (first and is_limit))
        if res is not None:
            off, px, reason = res
            return Exit(j + off, px, reason)
        pos.observe_path(m.h[j:e], m.l[j:e])
        first = False
        if e > hi:
            break
        # the tf candle is closed at ot[e]: update the trailing stop from closed data only
        k = int(np.searchsorted(arr["ot"], bar_open))
        if k < len(arr["ot"]) and arr["ot"][k] == bar_open and m.ot[e] == bar_open + step:
            pos.on_tf_close(int(m.ot[e]), arr["atr"][k],
                            arr[f"lo{dn}"][k] if dn else np.nan, arr[f"hi{dn}"][k] if dn else np.nan)
        j = e
    if j_time is not None and j_time <= j_end:
        return Exit(j_time, float(m.o[j_time]), "time")
    if hi == j_last:
        return Exit(j_last, float(m.c[j_last]), "end")
    return None


def find_limit_fill(m: SymbolMarket, j0: int, expiry_ms: int, direction: int, limit: float, j_last: int):
    """('fill', j) | ('expired', j) | ('void', j). A buy fills when low < limit (through), a sell when high > limit."""
    j_exp = int(np.searchsorted(m.ot, expiry_ms)) - 1
    g = m.next_gap(j0)
    hi = min(j_exp, j_last, g)
    if hi >= j0:
        seg = m.l[j0:hi + 1] < limit if direction > 0 else m.h[j0:hi + 1] > limit
        k = int(np.argmax(seg))
        if seg[k]:
            return "fill", j0 + k
    if hi == g and g < min(j_exp, j_last):
        return "void", g
    return "expired", max(hi, j0)


# ---------------------------------------------------------------- portfolio backtest

@dataclass
class Outcome:
    """Result of executing one signal on one symbol, independently of the portfolio."""
    status: str                    # trade | skip_no_bar | skip_filter | limit_expired | void_gap
    busy_until: int | None = None  # slot occupied until this ms (expired limits, voided trades)
    row: tuple | None = None
    exit_ms: int | None = None
    pnl: float = 0.0
    liquidated: bool = False
    capped: bool = False


def execute_signal(m: SymbolMarket, s: Signal, capital: float, costs: Costs, risk: dict, j_last: int) -> Outcome:
    """Fill, size, follow and close one signal (shared by the backtest, the random baseline and live tracking)."""
    t = s.generated_at
    j0 = m.index_at(t)
    if j0 < 0 or j0 > j_last:
        return Outcome("skip_no_bar")
    d = int(s.direction)
    is_limit = s.order_type == "limit"
    if is_limit:
        state, jf = find_limit_fill(m, j0, int(s.limit_expiry or t), d, float(s.entry), j_last)
        if state != "fill":
            return Outcome("limit_expired" if state == "expired" else "void_gap", busy_until=int(m.ot[jf]))
        j_entry, entry_raw = jf, float(s.entry)
        entry_price = entry_raw
    else:
        j_entry, entry_raw = j0, float(m.o[j0])
        stop_dist_raw = s.stop_offset if s.stop_offset is not None else abs(entry_raw - s.stop)
        notional_est = capital * risk["risk_per_trade"] * entry_raw / stop_dist_raw if stop_dist_raw > 0 else 0.0
        notional_est = min(notional_est, risk["max_leverage"] * capital)
        entry_price = entry_raw * (1.0 + d * m.slippage(j_entry, notional_est, costs))
    stop = float(s.stop)
    if s.stop_offset is not None and not is_limit:
        stop = entry_raw - d * float(s.stop_offset)
    r_dist = (entry_price - stop) * d
    if not np.isfinite(r_dist) or r_dist <= 0:
        return Outcome("skip_filter")
    stop_pct = r_dist / entry_price
    if stop_pct < risk["min_stop_pct"] or stop_pct > risk["max_stop_pct"]:
        return Outcome("skip_filter")
    rule = s.exit_rule
    tp = None
    if rule.tp_price is not None and np.isfinite(rule.tp_price):
        tp = float(rule.tp_price)
        if (tp - entry_price) * d <= 0:
            return Outcome("skip_filter")
    elif rule.tp_r is not None:
        tp = entry_price + d * rule.tp_r * r_dist
    size, capped = position_size(capital, risk["risk_per_trade"], r_dist, entry_price, risk["max_leverage"])
    if size <= 0:
        return Outcome("skip_filter")
    tf = rule.tf or s.tf_signal
    if tf not in m.tf:
        return Outcome("skip_no_bar")
    pos = Position(d, entry_price, stop, rule, liquidation_price(entry_price, d, risk), tp)
    hold = rule.max_hold_bars * (tf_ms(tf) // m.step) if rule.max_hold_bars else None
    ex = simulate_position(m, pos, j_entry, j_last, tf, is_limit, hold)
    if ex is None:
        return Outcome("void_gap", busy_until=int(m.ot[m.next_gap(j_entry)]))
    entry_fee = entry_price * size * (costs.maker if is_limit else costs.taker)
    if ex.reason == "tp":
        exit_price, exit_fee = ex.raw_price, ex.raw_price * size * costs.maker
    elif ex.reason == "liquidation":
        exit_price, exit_fee = ex.raw_price, 0.0
    else:
        exit_price = ex.raw_price * (1.0 - d * m.slippage(ex.j, size * ex.raw_price, costs))
        exit_fee = exit_price * size * costs.taker
    funding = m.funding_cost(d, size, entry_price, j_entry, ex.j, costs.funding_price)
    if ex.reason == "liquidation":
        pnl = -(entry_price * size / risk["max_leverage"]) - entry_fee - max(funding, 0.0)
    else:
        pnl = d * (exit_price - entry_price) * size - entry_fee - exit_fee - funding
    slip_cost = size * (abs(entry_price - entry_raw) + abs(exit_price - ex.raw_price))
    exit_ms = int(m.ot[ex.j])
    stop_atr = r_dist / s.atr if np.isfinite(s.atr) and s.atr > 0 else np.nan
    row = (s.id, s.concept, s.variant, s.symbol, "long" if d > 0 else "short", s.tf_signal, t,
           int(m.ot[j_entry]), entry_price, stop, np.nan if tp is None else tp, exit_ms, exit_price,
           ex.reason, size, size * entry_price, entry_fee + exit_fee, slip_cost, funding, pnl,
           pnl / (r_dist * size), ex.j - j_entry, size * r_dist / capital, len(pos.stop_moves), s.score, stop_atr)
    return Outcome("trade", row=row, exit_ms=exit_ms, pnl=pnl, liquidated=ex.reason == "liquidation", capped=capped)


def run_backtest(signals: list[Signal], market: dict[str, SymbolMarket], cfg: dict, start_ms: int, end_ms: int,
                 cost_mult: float = 1.0, portfolio: Portfolio | None = None,
                 initial_capital: float | None = None) -> tuple[pd.DataFrame, dict]:
    """Simulate ``signals`` generated in [start_ms, end_ms). Returns (trades, counters)."""
    risk = cfg["risk"]
    costs = Costs.from_config(cfg, cost_mult)
    pf = portfolio or Portfolio(cfg)
    if initial_capital is not None:
        pf.capital = float(initial_capital)
    sig = sorted((s for s in signals if start_ms <= s.generated_at < end_ms), key=lambda s: (s.generated_at, s.symbol))
    j_last = {sym: int(np.searchsorted(mk.ot, end_ms)) - 1 for sym, mk in market.items()}
    info = {"signals": len(sig), "taken": 0, "skip_no_bar": 0, "skip_filter": 0, "limit_expired": 0,
            "void_gap": 0, "leverage_capped": 0, "liquidations": 0}
    rows = []
    for s in sig:
        t = s.generated_at
        pf.release(t)
        why = pf.refuse_reason(s, t)
        if why:
            info[f"skip_{why}"] = info.get(f"skip_{why}", 0) + 1
            continue
        m = market.get(s.symbol)
        if m is None:
            info["skip_no_bar"] += 1
            continue
        out = execute_signal(m, s, pf.capital, costs, risk, j_last[s.symbol])
        if out.status != "trade":
            info[out.status] += 1
            if out.busy_until is not None:
                pf.occupy(s, out.busy_until)
            continue
        pf.open(s, out.exit_ms, out.pnl)
        info["taken"] += 1
        info["leverage_capped"] += int(out.capped)
        info["liquidations"] += int(out.liquidated)
        rows.append(out.row)
    trades = pd.DataFrame(rows, columns=TRADE_COLS)
    info["final_capital"] = pf.capital
    return trades, info
