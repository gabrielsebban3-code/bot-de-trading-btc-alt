"""
Moteur de simulation backtest barre-par-barre.
Rejoue les données 1m en alignant le contexte 5m correspondant.
Aucun look-ahead : à l'instant T, seules les données ≤ T sont visibles.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import numpy as np
import pandas as pd

from strategy.config import FEE_PERCENT, SLIPPAGE_PERCENT
from strategy.indicators import compute_all
from strategy.strategy import Signal, evaluate

logger = logging.getLogger(__name__)


# ─── Types de données ─────────────────────────────────────────────────────────

@dataclass
class Trade:
    """Représente un trade complet simulé."""
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
    exit_reason: str = ""   # "TP1", "TP2", "SL", "END"
    pnl_r: float = 0.0      # PnL exprimé en R (unités de risque)
    pnl_pct: float = 0.0    # PnL en % de l'entrée (après frais)
    fees_pct: float = 0.0


# ─── Simulateur de trade ──────────────────────────────────────────────────────

def _apply_slippage(price: float, side: str, direction: str) -> float:
    """
    Applique le slippage :
    - À l'entrée : défavorable (long → prix monte, short → prix descend)
    - À la sortie : défavorable (inverse)
    """
    slip = SLIPPAGE_PERCENT / 100
    if direction == "entry":
        return price * (1 + slip) if side == "LONG" else price * (1 - slip)
    else:  # exit
        return price * (1 - slip) if side == "LONG" else price * (1 + slip)


def simulate_trade(signal: Signal, future_bars: pd.DataFrame) -> Trade:
    """
    Simule la sortie d'un trade à partir des bougies futures (1m).
    Règle pessimiste : si SL et TP sont touchés dans la même bougie, SL gagne.

    Stratégie de sortie simple : vise TP2 (2R) ou SL.
    """
    entry = _apply_slippage(signal.entry, signal.side, "entry")
    fee_in = FEE_PERCENT / 100

    trade = Trade(
        symbol=signal.symbol,
        side=signal.side,
        entry_time=signal.timestamp,
        entry_price=entry,
        sl=signal.sl,
        tp1=signal.tp1,
        tp2=signal.tp2,
        rr=signal.rr,
        score=signal.score,
        fees_pct=fee_in * 2,  # entrée + sortie (estimé, mis à jour à la sortie)
    )

    risk = abs(entry - signal.sl)
    if risk == 0:
        # Cas dégénéré
        trade.exit_reason = "END"
        return trade

    for _, bar in future_bars.iterrows():
        h, l = bar["high"], bar["low"]
        bar_ts = bar["timestamp"]  # toujours utiliser la colonne timestamp, pas bar.name

        if signal.side == "LONG":
            # Vérifier SL d'abord (pessimiste)
            if l <= signal.sl:
                exit_px = _apply_slippage(signal.sl, signal.side, "exit")
                _close_trade(trade, exit_px, bar_ts, "SL", risk)
                return trade
            if h >= signal.tp2:
                exit_px = _apply_slippage(signal.tp2, signal.side, "exit")
                _close_trade(trade, exit_px, bar_ts, "TP2", risk)
                return trade
        else:  # SHORT
            if h >= signal.sl:
                exit_px = _apply_slippage(signal.sl, signal.side, "exit")
                _close_trade(trade, exit_px, bar_ts, "SL", risk)
                return trade
            if l <= signal.tp2:
                exit_px = _apply_slippage(signal.tp2, signal.side, "exit")
                _close_trade(trade, exit_px, bar_ts, "TP2", risk)
                return trade

    # Fin des données sans sortie → clôture au dernier prix
    last_bar = future_bars.iloc[-1]
    exit_px = _apply_slippage(float(last_bar["close"]), signal.side, "exit")
    _close_trade(trade, exit_px, last_bar["timestamp"], "END", risk)
    return trade


def _close_trade(
    trade: Trade,
    exit_px: float,
    exit_time: datetime,
    reason: str,
    risk: float,
) -> None:
    """Met à jour le trade avec les valeurs de sortie."""
    fee_out = FEE_PERCENT / 100
    trade.exit_time = exit_time
    trade.exit_price = exit_px
    trade.exit_reason = reason

    if trade.side == "LONG":
        gross_pct = (exit_px - trade.entry_price) / trade.entry_price * 100
    else:
        gross_pct = (trade.entry_price - exit_px) / trade.entry_price * 100

    total_fees = (FEE_PERCENT + FEE_PERCENT + SLIPPAGE_PERCENT + SLIPPAGE_PERCENT)
    trade.pnl_pct = gross_pct - total_fees
    trade.pnl_r = trade.pnl_pct / (risk / trade.entry_price * 100) if risk > 0 else 0
    trade.fees_pct = total_fees


# ─── Boucle de replay ─────────────────────────────────────────────────────────

def run_backtest_symbol(
    symbol: str,
    df_1m: pd.DataFrame,
    df_5m: pd.DataFrame,
    min_bars_warmup: int = 60,
) -> list[Trade]:
    """
    Rejoue les données barre par barre pour un symbole.
    Retourne la liste des trades simulés.
    """
    logger.info("Backtest %s : %d bougies 1m, %d bougies 5m", symbol, len(df_1m), len(df_5m))

    # Pré-calcul des indicateurs sur l'ensemble des données
    df_1m = compute_all(df_1m.copy())
    df_5m = compute_all(df_5m.copy())

    trades: list[Trade] = []
    active_trade: Optional[Trade] = None
    active_signal_end: Optional[datetime] = None  # index de fin du trade en cours

    # Série pandas des timestamps 5m (garde le type tz-aware pour comparaison directe)
    ts_5m_series = df_5m["timestamp"]

    for i in range(min_bars_warmup, len(df_1m)):
        current_bar = df_1m.iloc[i]
        current_ts: pd.Timestamp = current_bar["timestamp"]

        # Si un trade est en cours, on ne cherche pas de nouveau signal
        if active_trade is not None:
            if active_signal_end is not None and current_ts >= active_signal_end:
                active_trade = None
                active_signal_end = None
            continue

        # ── Construire le contexte sans look-ahead ────────────────────────────
        # 1m : toutes les bougies jusqu'à i (inclus)
        slice_1m = df_1m.iloc[: i + 1]

        # 5m : toutes les bougies dont timestamp ≤ current_ts (comparaison pandas tz-aware)
        mask_5m = ts_5m_series <= current_ts
        slice_5m = df_5m[mask_5m]

        if len(slice_5m) < min_bars_warmup or len(slice_1m) < min_bars_warmup:
            continue

        # ── Évaluation de la stratégie ────────────────────────────────────────
        signal: Optional[Signal] = evaluate(slice_5m, slice_1m, symbol)

        if signal is None:
            continue

        # En backtest, le timestamp du signal = la bougie déclencheur (pas utcnow)
        signal.timestamp = current_ts.to_pydatetime()

        # ── Simulation de la sortie ───────────────────────────────────────────
        future_bars = df_1m.iloc[i + 1 :]  # bougies après le signal
        if len(future_bars) == 0:
            break

        trade = simulate_trade(signal, future_bars)
        trades.append(trade)
        logger.info(
            "%s [%s] %s @ %.4f → %s %.2f R",
            trade.entry_time,
            symbol,
            trade.side,
            trade.entry_price,
            trade.exit_reason,
            trade.pnl_r,
        )

        # Éviter les entrées pendant que le trade est en cours
        if trade.exit_time is not None:
            active_trade = trade
            active_signal_end = trade.exit_time

    return trades
