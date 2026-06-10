"""
Moteur de simulation backtest barre-par-barre — Sweep + MSS Strategy.
Gère les entrées en ordre limite (zone OTE) plutôt qu'en market order.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import pandas as pd

from strategy.config import FEE_PERCENT, SLIPPAGE_PERCENT
from strategy.indicators import compute_all
from strategy.strategy import Signal, evaluate

logger = logging.getLogger(__name__)


# ─── Trade ────────────────────────────────────────────────────────────────────

@dataclass
class Trade:
    symbol: str
    side: str
    entry_time: datetime
    entry_price: float
    sl: float
    tp1: float
    tp2: float
    rr: float
    score: int
    exit_time: Optional[datetime] = None
    exit_price: Optional[float] = None
    exit_reason: str = ""
    pnl_r: float = 0.0
    pnl_pct: float = 0.0
    fees_pct: float = 0.0


# ─── Slippage ─────────────────────────────────────────────────────────────────

def _slip(price: float, side: str, direction: str) -> float:
    s = SLIPPAGE_PERCENT / 100
    if direction == "entry":
        return price * (1 + s) if side == "LONG" else price * (1 - s)
    return price * (1 - s) if side == "LONG" else price * (1 + s)


# ─── Clôture d'un trade ───────────────────────────────────────────────────────

def _close(trade: Trade, exit_px: float, exit_ts: datetime, reason: str, risk: float) -> None:
    trade.exit_time = exit_ts
    trade.exit_price = exit_px
    trade.exit_reason = reason
    total_fees = (FEE_PERCENT + FEE_PERCENT + SLIPPAGE_PERCENT + SLIPPAGE_PERCENT)

    if trade.side == "LONG":
        gross_pct = (exit_px - trade.entry_price) / trade.entry_price * 100
    else:
        gross_pct = (trade.entry_price - exit_px) / trade.entry_price * 100

    trade.pnl_pct = gross_pct - total_fees
    trade.pnl_r = trade.pnl_pct / (risk / trade.entry_price * 100) if risk > 0 else 0
    trade.fees_pct = total_fees


# ─── Simulation ordre limite en zone OTE ─────────────────────────────────────

def simulate_trade(signal: Signal, future_bars: pd.DataFrame) -> Trade:
    """
    Phase 1 : attend que le prix retrace dans la zone OTE pour remplir l'ordre limite.
    Phase 2 : gestion SL / TP2 après le fill.
    Règle pessimiste : SL vérifié avant TP dans la même bougie.
    """
    trade = Trade(
        symbol=signal.symbol,
        side=signal.side,
        entry_time=signal.timestamp,
        entry_price=0.0,
        sl=signal.sl,
        tp1=signal.tp1,
        tp2=signal.tp2,
        rr=signal.rr,
        score=signal.score,
    )

    filled = False
    filled_risk = 0.0

    for _, bar in future_bars.iterrows():
        ts = bar["timestamp"]
        h, l = float(bar["high"]), float(bar["low"])

        if not filled:
            # ── Phase 1 : attente du fill ─────────────────────────────────────
            if signal.side == "LONG":
                # SL touché avant le fill → pas d'entrée
                if l <= signal.sl:
                    trade.exit_reason = "NO_FILL_SL"
                    trade.exit_time = ts
                    trade.pnl_r = 0.0
                    return trade
                # Prix entre dans la zone OTE → fill
                if l <= signal.ote_upper:
                    trade.entry_price = _slip(signal.entry, "LONG", "entry")
                    trade.entry_time = ts
                    filled = True
                    filled_risk = abs(trade.entry_price - signal.sl)
            else:  # SHORT
                if h >= signal.sl:
                    trade.exit_reason = "NO_FILL_SL"
                    trade.exit_time = ts
                    trade.pnl_r = 0.0
                    return trade
                if h >= signal.ote_lower:
                    trade.entry_price = _slip(signal.entry, "SHORT", "entry")
                    trade.entry_time = ts
                    filled = True
                    filled_risk = abs(signal.sl - trade.entry_price)

        if filled:
            # ── Phase 2 : gestion du trade (SL avant TP — pessimiste) ─────────
            if signal.side == "LONG":
                if l <= signal.sl:
                    _close(trade, _slip(signal.sl, "LONG", "exit"), ts, "SL", filled_risk)
                    return trade
                if h >= signal.tp2:
                    _close(trade, _slip(signal.tp2, "LONG", "exit"), ts, "TP2", filled_risk)
                    return trade
            else:
                if h >= signal.sl:
                    _close(trade, _slip(signal.sl, "SHORT", "exit"), ts, "SL", filled_risk)
                    return trade
                if l <= signal.tp2:
                    _close(trade, _slip(signal.tp2, "SHORT", "exit"), ts, "TP2", filled_risk)
                    return trade

    if not filled:
        trade.exit_reason = "NO_FILL_TIMEOUT"
        if len(future_bars) > 0:
            trade.exit_time = future_bars.iloc[-1]["timestamp"]
        return trade

    # Fin des données sans sortie
    last = future_bars.iloc[-1]
    _close(trade, _slip(float(last["close"]), signal.side, "exit"), last["timestamp"], "END", filled_risk)
    return trade


# ─── Replay barre-par-barre ───────────────────────────────────────────────────

def run_backtest_symbol(
    symbol: str,
    df_1m: pd.DataFrame,
    df_5m: pd.DataFrame,
    min_bars_warmup: int = 80,
) -> list[Trade]:
    """
    Rejoue les données 1m barre par barre.
    Les indicateurs sont pré-calculés une seule fois (perf).
    """
    logger.info("Backtest %s : %d×1m  %d×5m", symbol, len(df_1m), len(df_5m))

    # Pré-calcul unique des indicateurs sur tout le dataset
    df_1m = compute_all(df_1m.copy())
    df_5m = compute_all(df_5m.copy())

    trades: list[Trade] = []
    active_trade: Optional[Trade] = None
    active_end: Optional[pd.Timestamp] = None

    ts_5m = df_5m["timestamp"]

    for i in range(min_bars_warmup, len(df_1m)):
        current_ts: pd.Timestamp = df_1m.iloc[i]["timestamp"]

        # Skip si un trade est ouvert
        if active_trade is not None:
            if active_end is not None and current_ts >= active_end:
                active_trade = None
                active_end = None
            continue

        # Slice sans lookahead
        slice_1m = df_1m.iloc[: i + 1]
        slice_5m = df_5m[ts_5m <= current_ts]

        if len(slice_5m) < 20 or len(slice_1m) < min_bars_warmup:
            continue

        signal: Optional[Signal] = evaluate(slice_5m, slice_1m, symbol)

        if signal is None:
            continue

        # Timestamp = bougie courante (pas utcnow)
        signal.timestamp = current_ts.to_pydatetime()

        future = df_1m.iloc[i + 1 :]
        if len(future) == 0:
            break

        trade = simulate_trade(signal, future)
        trades.append(trade)

        logger.info(
            "%s [%s] %s @ %.4f → %s %.2fR",
            trade.entry_time, symbol, trade.side,
            trade.entry_price, trade.exit_reason, trade.pnl_r,
        )

        if trade.exit_time is not None:
            active_trade = trade
            active_end = trade.exit_time

    return trades
