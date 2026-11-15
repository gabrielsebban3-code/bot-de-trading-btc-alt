"""Simulation engine: 15m resolution, own fill rules, portfolio constraints, costs, funding.

Fill hypotheses (see section 6 of the mission and DECISIONS.md):
* market order  -> open of the next 15m candle, adverse slippage, taker fee;
* limit order   -> filled only if price trades THROUGH the level, at the limit price, maker fee;
* stop          -> triggered when the candle reaches the level, filled at the level (or at the open
                   when the candle gaps beyond it), adverse slippage, taker fee;
* take-profit   -> filled only if price trades THROUGH the level, maker fee, no slippage;
* stop and take-profit in the same 15m candle -> the stop wins;
* a take-profit cannot be filled on the candle where a limit entry was filled (unknown order).
"""
from __future__ import annotations

import heapq
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .data import BAR_MS, TF_MS, find_gaps

TRADE_COLUMNS = [
    "trade_id", "famille", "config_id", "symbole", "direction", "signal_time", "entry_time",
    "entry_price", "stop_price", "tp_price", "exit_time", "exit_price", "exit_reason", "size",
    "notional", "fees", "slippage", "funding", "pnl_usdt", "r_multiple_net", "bars_held",
    "risk_pct_actual",
]

SIGNAL_COLUMNS = [
    "symbol", "order_time", "direction", "order_type", "limit_price", "stop_price", "stop_dist",
    "tp_r", "tp_price", "trail_mult", "max_hold_ms", "expiry_ms", "atr", "tf",
]


@dataclass(frozen=True)
class Costs:
    maker: float
    taker: float
    slippage: float

    @staticmethod
    def from_config(cfg: dict, multiplier: float = 1.0) -> "Costs":
        c = cfg["costs"]
        return Costs(c["maker_fee"] * multiplier, c["taker_fee"] * multiplier, c["slippage"] * multiplier)


class SymbolData:
    """15m arrays of one symbol plus funding and higher-timeframe arrays used for trailing stops."""

    def __init__(self, symbol: str, df15: pd.DataFrame, funding: pd.DataFrame | None = None):
        self.symbol = symbol
        self.ot = df15["open_time"].to_numpy(dtype="int64")
        self.o = df15["open"].to_numpy(dtype="float64")
        self.h = df15["high"].to_numpy(dtype="float64")
        self.l = df15["low"].to_numpy(dtype="float64")
        self.c = df15["close"].to_numpy(dtype="float64")
        # indices g such that candle g + 1 is not adjacent to candle g
        diff = np.diff(self.ot)
        self.gap_idx = np.nonzero(diff != BAR_MS)[0].astype("int64")
        self.gaps = find_gaps(self.ot)
        if funding is not None and len(funding):
            ft = funding["funding_time"].to_numpy(dtype="int64")
            self.f_time = (ft // 60_000) * 60_000          # settlement instants floored to the minute
            self.f_cum = np.concatenate(([0.0], np.cumsum(funding["funding_rate"].to_numpy(dtype="float64"))))
        else:
            self.f_time = np.zeros(0, dtype="int64")
            self.f_cum = np.zeros(1)
        self.tf: dict[str, dict] = {}

    def add_tf(self, tf: str, open_time: np.ndarray, high: np.ndarray, low: np.ndarray, atr: np.ndarray) -> None:
        self.tf[tf] = {"ot": np.asarray(open_time, dtype="int64"), "h": np.asarray(high, dtype="float64"),
                       "l": np.asarray(low, dtype="float64"), "atr": np.asarray(atr, dtype="float64")}

    def index_of(self, t_ms: int) -> int:
        """Index of the 15m candle opening exactly at ``t_ms`` or -1."""
        j = int(np.searchsorted(self.ot, t_ms))
        if j < len(self.ot) and self.ot[j] == t_ms:
            return j
        return -1

    def next_gap(self, j: int) -> int:
        """Smallest index g >= j whose next candle is missing; len(ot) - 1 when none."""
        p = int(np.searchsorted(self.gap_idx, j))
        if p < len(self.gap_idx):
            return int(self.gap_idx[p])
        return len(self.ot) - 1

    def funding_sum(self, entry_bar_ms: int, exit_bar_ms: int) -> float:
        """Sum of funding rates settled at times f with entry_bar_ms < f <= exit_bar_ms."""
        a = int(np.searchsorted(self.f_time, entry_bar_ms, side="right"))
        b = int(np.searchsorted(self.f_time, exit_bar_ms, side="right"))
        return float(self.f_cum[b] - self.f_cum[a])


# ---------------------------------------------------------------- single-position path simulation

def _trail_stops(sd: SymbolData, tf: str, k_entry: int, m0: int, count: int, direction: int,
                 mult: float, carry_stop: float, carry_ext: float) -> tuple[np.ndarray, float, float]:
    """Stops applying during higher-timeframe candles m0 .. m0 + count - 1 after the entry candle.

    The stop used during candle m only depends on candles closed before m (chandelier exit:
    highest high since entry - mult x ATR for a long, never moving backwards).
    Returns (stops per candle, carry stop for the next chunk, carry extreme).
    """
    arr = sd.tf[tf]
    a, b = k_entry + m0, k_entry + m0 + count
    atr = arr["atr"][a:b]
    if direction > 0:
        ext = np.maximum(np.maximum.accumulate(arr["h"][a:b]), carry_ext)
        cand = ext - mult * atr
        run = np.fmax.accumulate(np.fmax(cand, carry_stop))
    else:
        ext = np.minimum(np.minimum.accumulate(arr["l"][a:b]), carry_ext)
        cand = ext + mult * atr
        run = np.fmin.accumulate(np.fmin(cand, carry_stop))
    n_avail = len(run)
    stops = np.full(count, carry_stop, dtype="float64")
    m = min(count - 1, n_avail)
    if m > 0:
        stops[1: 1 + m] = run[:m]
        stops[1 + m:] = run[m - 1]   # candles beyond the available history keep the last known stop
    if n_avail >= count:
        return stops, float(run[count - 1]), float(ext[count - 1])
    if n_avail > 0:
        return stops, float(run[n_avail - 1]), float(ext[n_avail - 1])
    return stops, carry_stop, carry_ext


def simulate_exit(sd: SymbolData, j_entry: int, direction: int, stop0: float, tp: float | None,
                  j_time: int | None, j_last: int, liq_price: float,
                  trail: tuple[str, int, float] | None = None, tp_on_entry_bar: bool = True):
    """Walk 15m candles from ``j_entry`` until the position is closed.

    Returns (status, j_exit, raw_exit_price, reason) with status 'ok' or 'void' (a data gap was hit).
    ``trail`` = (timeframe, index of the entry candle in that timeframe, ATR multiple).
    ``j_time`` = index of the candle at whose open a time exit happens; ``j_last`` = last candle of the set.
    """
    g = sd.next_gap(j_entry)
    j_end = min(j_last, g)
    hi = j_end
    if j_time is not None and j_time - 1 < hi:
        hi = j_time - 1
    o, h, l = sd.o, sd.h, sd.l
    j = j_entry
    chunk = 64
    if trail is not None:
        tf, k_entry, mult = trail
        q = TF_MS[tf] // BAR_MS
        carry_stop = stop0
        carry_ext = -np.inf if direction > 0 else np.inf
        m0 = 0
        chunk = max(q, (64 // q) * q)
    while j <= hi:
        e = min(hi + 1, j + chunk)
        lo_, hi_ = l[j:e], h[j:e]
        if trail is not None:
            count = -(-(e - j) // q)
            tf_stops, carry_stop, carry_ext = _trail_stops(sd, tf, k_entry, m0, count, direction, mult,
                                                           carry_stop, carry_ext)
            stops = np.repeat(tf_stops, q)[: e - j]
            m0 += count
        else:
            stops = stop0
        if direction > 0:
            s_hit = lo_ <= stops
            t_hit = hi_ > tp if tp is not None else None
        else:
            s_hit = hi_ >= stops
            t_hit = lo_ < tp if tp is not None else None
        if t_hit is not None:
            if not tp_on_entry_bar and j == j_entry:
                t_hit = t_hit.copy()
                t_hit[0] = False
            any_hit = s_hit | t_hit
        else:
            any_hit = s_hit
        k = int(np.argmax(any_hit))
        if any_hit[k]:
            jx = j + k
            if s_hit[k]:  # the stop wins when both are hit in the same candle
                level = float(stops[k]) if trail is not None else stop0
                if direction > 0:
                    px = min(float(o[jx]), level)
                    liquidated = px <= liq_price
                else:
                    px = max(float(o[jx]), level)
                    liquidated = px >= liq_price
                if liquidated:
                    return "ok", jx, liq_price, "liquidation"
                reason = "trail" if (trail is not None and level != stop0) else "stop"
                return "ok", jx, px, reason
            return "ok", jx, float(tp), "tp"
        j = e
        chunk *= 4
        if trail is not None:
            chunk = max(q, (chunk // q) * q)
    if j_time is not None and j_time <= j_end:
        return "ok", j_time, float(o[j_time]), "time"
    if hi == j_last:
        return "ok", j_last, float(sd.c[j_last]), "time_close"
    return "void", hi, float("nan"), "gap"


def run_trade(sd: SymbolData, j_entry: int, direction: int, entry_raw: float, is_limit: bool,
              stop_price: float, tp_r: float | None, tp_price: float | None,
              trail: tuple[str, int, float] | None, hold_bars: int | None, j_last: int,
              costs: Costs, eng: dict, entry_slips: bool | None = None,
              tp_on_entry_bar: bool | None = None) -> dict | None:
    """Simulate one position for a size of 1 unit. Returns None when the signal must be ignored.

    The result holds per-unit amounts; the caller scales them by the position size.
    Returned 'status' is 'ok' or 'void'.
    """
    if entry_slips is None:
        entry_slips = not is_limit
    if tp_on_entry_bar is None:
        tp_on_entry_bar = not is_limit
    entry_price = entry_raw * (1.0 + direction * costs.slippage) if entry_slips else entry_raw
    r_dist = (entry_price - stop_price) * direction
    if not np.isfinite(r_dist) or r_dist <= 0:
        return None
    stop_pct = r_dist / entry_price
    if stop_pct < eng["min_stop_pct"] or stop_pct > eng["max_stop_pct"]:
        return None
    tp = None
    if tp_price is not None and np.isfinite(tp_price):
        tp = float(tp_price)
        if (tp - entry_price) * direction <= 0:
            return None  # target already behind the entry price
    elif tp_r is not None and np.isfinite(tp_r):
        tp = entry_price + direction * tp_r * r_dist
    liq_dist = 1.0 / eng["max_leverage"] - eng["maintenance_margin_rate"]
    liq_price = entry_price * (1.0 - direction * liq_dist)
    j_time = j_entry + hold_bars if hold_bars else None
    status, jx, exit_raw, reason = simulate_exit(sd, j_entry, direction, stop_price, tp, j_time, j_last,
                                                 liq_price, trail, tp_on_entry_bar)
    if status == "void":
        return {"status": "void", "j_exit": jx}
    entry_fee = entry_price * (costs.maker if is_limit else costs.taker)
    entry_slip = abs(entry_price - entry_raw)
    funding = direction * entry_price * sd.funding_sum(int(sd.ot[j_entry]), int(sd.ot[jx]))
    if reason == "tp":
        exit_price, exit_fee, exit_slip = exit_raw, exit_raw * costs.maker, 0.0
    elif reason == "liquidation":
        exit_price, exit_fee, exit_slip = exit_raw, 0.0, 0.0
    else:  # stop, trail, time: market execution
        exit_price = exit_raw * (1.0 - direction * costs.slippage)
        exit_fee = exit_price * costs.taker
        exit_slip = abs(exit_price - exit_raw)
    if reason == "liquidation":
        pnl = -(entry_price / eng["max_leverage"]) - entry_fee - max(funding, 0.0)
    else:
        pnl = direction * (exit_price - entry_price) - entry_fee - exit_fee - funding
    return {
        "status": "ok", "j_entry": j_entry, "j_exit": jx, "entry_price": entry_price, "stop_price": stop_price,
        "tp_price": tp if tp is not None else float("nan"), "exit_price": exit_price,
        "exit_reason": "time" if reason == "time_close" else reason, "fees": entry_fee + exit_fee,
        "slippage": entry_slip + exit_slip, "funding": funding, "pnl": pnl, "r_dist": r_dist,
        "r_multiple": pnl / r_dist,
    }


def find_limit_fill(sd: SymbolData, j_start: int, expiry_ms: int, direction: int, limit: float, j_last: int):
    """First 15m candle trading through the limit price before expiry.

    Returns ('fill', j) | ('expired', j_last_live) | ('void', j_gap).
    A buy limit is filled when low < limit, a sell limit when high > limit (a touch is not a fill).
    """
    j_exp = int(np.searchsorted(sd.ot, expiry_ms)) - 1   # last candle opening before expiry
    g = sd.next_gap(j_start)
    hi = min(j_exp, j_last, g)
    if hi >= j_start:
        seg = sd.l[j_start: hi + 1] < limit if direction > 0 else sd.h[j_start: hi + 1] > limit
        k = int(np.argmax(seg))
        if seg[k]:
            return "fill", j_start + k
    if hi == g and g < min(j_exp, j_last):
        return "void", g
    return "expired", max(hi, j_start)


# ---------------------------------------------------------------- portfolio loop

def run_backtest(signals: pd.DataFrame, market: dict[str, SymbolData], cfg: dict, start_ms: int, end_ms: int,
                 famille: str, config_id: str, cost_mult: float = 1.0) -> tuple[pd.DataFrame, dict]:
    """Run one configuration over [start_ms, end_ms).

    ``signals`` holds the orders of every symbol (see SIGNAL_COLUMNS). They are processed in
    chronological order, ties broken by symbol (alphabetical), then by original order.
    """
    eng = cfg["engine"]
    costs = Costs.from_config(cfg, cost_mult)
    capital = float(eng["initial_capital"])
    sig = signals[(signals["order_time"] >= start_ms) & (signals["order_time"] < end_ms)]
    sig = sig.sort_values(["order_time", "symbol"], kind="stable")
    j_last_by_symbol = {s: int(np.searchsorted(sd.ot, end_ms)) - 1 for s, sd in market.items()}
    slots: dict[str, int] = {}          # symbol -> open time of the candle that frees the slot
    pending_pnl: list[tuple[int, int, float]] = []  # heap of (exit bar open time, seq, pnl)
    rows, aux = [], []
    info = {"signals": int(len(sig)), "taken": 0, "skip_pair_busy": 0, "skip_portfolio_full": 0,
            "skip_filter": 0, "skip_no_bar": 0, "limit_expired": 0, "void_gap": 0, "leverage_capped": 0,
            "liquidations": 0, "skip_no_capital": 0}
    seq = 0
    for s in sig.itertuples(index=False):
        t_o = int(s.order_time)
        while pending_pnl and pending_pnl[0][0] < t_o:
            capital += heapq.heappop(pending_pnl)[2]
        if slots:
            for sym in [k for k, v in slots.items() if v < t_o]:
                del slots[sym]
        if s.symbol in slots:
            info["skip_pair_busy"] += 1
            continue
        if len(slots) >= eng["max_positions"]:
            info["skip_portfolio_full"] += 1
            continue
        if capital <= 0:
            info["skip_no_capital"] += 1
            continue
        sd = market[s.symbol]
        j_last = j_last_by_symbol[s.symbol]
        j0 = sd.index_of(t_o)
        if j0 < 0 or j0 > j_last:
            info["skip_no_bar"] += 1
            continue
        direction = int(s.direction)
        is_limit = s.order_type == "limit"
        if is_limit:
            limit = float(s.limit_price)
            stop_price = float(s.stop_price)
            pct = (limit - stop_price) * direction / limit
            if not (eng["min_stop_pct"] <= pct <= eng["max_stop_pct"]):
                info["skip_filter"] += 1
                continue
            state, jf = find_limit_fill(sd, j0, int(s.expiry_ms), direction, limit, j_last)
            if state != "fill":
                slots[s.symbol] = int(sd.ot[jf])
                info["limit_expired" if state == "expired" else "void_gap"] += 1
                continue
            j_entry, entry_raw = jf, limit
        else:
            j_entry, entry_raw = j0, float(sd.o[j0])
            if np.isfinite(s.stop_price):
                stop_price = float(s.stop_price)
            else:
                stop_price = entry_raw - direction * float(s.stop_dist)
        trail = None
        if np.isfinite(s.trail_mult):
            tfa = sd.tf[s.tf]["ot"]
            k_entry = int(np.searchsorted(tfa, sd.ot[j_entry]))
            if k_entry >= len(tfa) or tfa[k_entry] != sd.ot[j_entry]:
                info["skip_no_bar"] += 1
                continue
            trail = (s.tf, k_entry, float(s.trail_mult))
        hold_bars = int(s.max_hold_ms // BAR_MS) if np.isfinite(s.max_hold_ms) and s.max_hold_ms > 0 else None
        res = run_trade(sd, j_entry, direction, entry_raw, is_limit, stop_price,
                        float(s.tp_r) if np.isfinite(s.tp_r) else None,
                        float(s.tp_price) if np.isfinite(s.tp_price) else None,
                        trail, hold_bars, j_last, costs, eng)
        if res is None:
            info["skip_filter"] += 1
            continue
        if res["status"] == "void":
            slots[s.symbol] = int(sd.ot[res["j_exit"]])
            info["void_gap"] += 1
            continue
        size = capital * eng["risk_per_trade"] / res["r_dist"]
        max_size = eng["max_leverage"] * capital / res["entry_price"]
        if size > max_size:
            size = max_size
            info["leverage_capped"] += 1
        pnl = res["pnl"] * size
        exit_ms = int(sd.ot[res["j_exit"]])
        slots[s.symbol] = exit_ms
        heapq.heappush(pending_pnl, (exit_ms, seq, pnl))
        seq += 1
        info["taken"] += 1
        if res["exit_reason"] == "liquidation":
            info["liquidations"] += 1
        rows.append((
            seq, famille, config_id, s.symbol, "long" if direction > 0 else "short", t_o, int(sd.ot[j_entry]),
            res["entry_price"], res["stop_price"], res["tp_price"], exit_ms, res["exit_price"], res["exit_reason"],
            size, size * res["entry_price"], res["fees"] * size, res["slippage"] * size, res["funding"] * size,
            pnl, res["r_multiple"], res["j_exit"] - j_entry, size * res["r_dist"] / capital,
        ))
        atr = float(s.atr)
        aux.append((res["r_dist"] / atr, abs(res["tp_price"] - res["entry_price"]) / atr))
    trades = pd.DataFrame(rows, columns=TRADE_COLUMNS)
    for col in ("signal_time", "entry_time", "exit_time"):
        trades[col] = pd.to_datetime(trades[col].astype("int64"), unit="ms", utc=True)
    info["stop_dist_atr"] = np.array([a[0] for a in aux], dtype="float64")
    info["tp_dist_atr"] = np.array([a[1] for a in aux], dtype="float64")
    return trades, info


# ---------------------------------------------------------------- random-entry baseline

def baseline_pool(market: dict[str, SymbolData], cfg: dict, start_ms: int, end_ms: int, tf: str,
                  eligible: dict[str, np.ndarray], symbols: np.ndarray, stop_dist_atr: np.ndarray,
                  tp_dist_atr: np.ndarray, tp_mode: str, tp_r: float | None, trail_mult: float | None,
                  max_hold_ms: float | None, entry_is_limit: bool, pool_size: int, rng: np.random.Generator,
                  cost_mult: float = 1.0) -> np.ndarray:
    """R multiples of ``pool_size`` random entries sharing the exit structure and costs of a configuration.

    Each random entry copies the symbol, stop distance (in ATR) and, if any, target distance (in ATR)
    of one real trade drawn at random; the entry candle and the direction are random.
    ``eligible[symbol]`` = indices (in the timeframe arrays) of candles at whose open an entry is allowed.
    ``tp_mode``: 'r' (target = tp_r x R), 'atr' (target distance copied from the real trade) or 'none'.
    """
    eng = cfg["engine"]
    costs = Costs.from_config(cfg, cost_mult)
    out = np.empty(pool_size)
    j_last_by_symbol = {s: int(np.searchsorted(sd.ot, end_ms)) - 1 for s, sd in market.items()}
    hold_bars = int(max_hold_ms // BAR_MS) if max_hold_ms else None
    filled, attempts, max_attempts = 0, 0, pool_size * 50
    n_real = len(symbols)
    while filled < pool_size and attempts < max_attempts:
        batch = pool_size - filled
        pick = rng.integers(0, n_real, size=batch)
        u = rng.random(batch)
        dirs = rng.integers(0, 2, size=batch) * 2 - 1
        for b in range(batch):
            attempts += 1
            i = pick[b]
            sym = symbols[i]
            el = eligible.get(sym)
            if el is None or len(el) == 0:
                continue
            sd = market[sym]
            arr = sd.tf[tf]
            k = int(el[int(u[b] * len(el))])
            atr = arr["atr"][k - 1]
            j_entry = sd.index_of(int(arr["ot"][k]))
            if j_entry < 0 or not np.isfinite(atr) or atr <= 0:
                continue
            d = int(dirs[b])
            entry_raw = float(sd.o[j_entry])
            entry_price = entry_raw if entry_is_limit else entry_raw * (1.0 + d * costs.slippage)
            stop_price = entry_price - d * stop_dist_atr[i] * atr
            tp_price = None
            if tp_mode == "atr":
                tp_price = entry_price + d * tp_dist_atr[i] * atr
            trail = (tf, k, float(trail_mult)) if trail_mult else None
            res = run_trade(sd, j_entry, d, entry_raw, entry_is_limit, stop_price,
                            tp_r if tp_mode == "r" else None, tp_price, trail, hold_bars,
                            j_last_by_symbol[sym], costs, eng, entry_slips=not entry_is_limit,
                            tp_on_entry_bar=True)
            if res is None or res["status"] != "ok":
                continue
            out[filled] = res["r_multiple"]
            filled += 1
            if filled >= pool_size:
                break
    return out[:filled]
