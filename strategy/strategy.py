"""
Liquidity Sweep + Market Structure Shift (MSS) — source de vérité unique.
Partagée entre live et backtest. Aucune duplication de logique ailleurs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import pandas as pd

from strategy.config import (
    FIB_OTE_LOWER,
    FIB_OTE_UPPER,
    MIN_ATR_PERCENT,
    MIN_SCORE,
    MSS_MAX_BARS,
    MSS_MIN_BARS,
    MSS_VOLUME_MULTIPLIER,
    RISK_REWARD_MIN,
    SL_BUFFER_PCT,
    SWEEP_LOOKBACK_BARS,
    SWEEP_VOLUME_MULTIPLIER,
    SWING_LOOKBACK,
    TP1_RR,
    TP2_RR,
)
from strategy.indicators import compute_all, find_swing_highs, find_swing_lows

logger = logging.getLogger(__name__)


# ─── Dataclasses ──────────────────────────────────────────────────────────────

@dataclass
class MSSSnapshot:
    """Niveaux clés du setup pour affichage Discord."""
    sweep_level: float    # swing balayé
    sweep_wick: float     # extrême de la mèche
    mss_level: float      # niveau de la cassure MSS
    fib_high: float       # ancre haute Fibonacci
    fib_low: float        # ancre basse Fibonacci
    fib_618: float        # 61.8% — limite haute OTE (long)
    fib_786: float        # 78.6% — limite basse OTE (long)
    atr: float
    sweep_vol_ratio: float
    mss_vol_ratio: float


@dataclass
class Signal:
    symbol: str
    side: str           # "LONG" ou "SHORT"
    entry: float        # milieu de la zone OTE
    ote_upper: float    # limite haute OTE (61.8% pour long, 78.6% pour short)
    ote_lower: float    # limite basse OTE  (78.6% pour long, 61.8% pour short)
    sl: float
    tp1: float          # 2R
    tp2: float          # 3R
    rr: float
    score: int
    indicators: MSSSnapshot
    timestamp: datetime
    timeframe_sweep: str = "1m"
    risk: float = field(init=False)

    def __post_init__(self) -> None:
        self.risk = abs(self.entry - self.sl)


# ─── Fibonacci ────────────────────────────────────────────────────────────────

def _fib_long(fib_low: float, fib_high: float) -> tuple[float, float]:
    """
    Retracement haussier (sweep bas → MSS haut).
    Retourne (ote_upper, ote_lower) où ote_upper > ote_lower.
    """
    rng = fib_high - fib_low
    ote_upper = fib_high - rng * FIB_OTE_UPPER   # 61.8% depuis le haut
    ote_lower = fib_high - rng * FIB_OTE_LOWER   # 78.6% depuis le haut
    return ote_upper, ote_lower


def _fib_short(fib_low: float, fib_high: float) -> tuple[float, float]:
    """
    Retracement baissier (sweep haut → MSS bas).
    Retourne (ote_upper, ote_lower) où ote_upper > ote_lower.
    """
    rng = fib_high - fib_low
    ote_lower = fib_low + rng * FIB_OTE_UPPER    # 61.8% depuis le bas
    ote_upper = fib_low + rng * FIB_OTE_LOWER    # 78.6% depuis le bas
    return ote_upper, ote_lower


# ─── Score ────────────────────────────────────────────────────────────────────

def _score(
    sweep_vol: float,
    mss_vol: float,
    ote_depth: float,  # 0.0 = à 61.8%, 1.0 = à 78.6%
    atr_pct: float,
) -> int:
    s_vol = min(30, int(min(sweep_vol / 3.0, 1.0) * 30))
    m_vol = min(30, int(min(mss_vol / 3.0, 1.0) * 30))
    ote_s = int(ote_depth * 25)
    atr_s = int(min(atr_pct / 0.3, 1.0) * 15)
    return s_vol + m_vol + ote_s + atr_s


# ─── Détection bullish ────────────────────────────────────────────────────────

def _find_bullish(
    df: pd.DataFrame,
    is_sh: pd.Series,
    is_sl: pd.Series,
    symbol: str,
) -> Optional[Signal]:
    """
    Cherche : Bullish Sweep → MSS haussier → prix actuellement en zone OTE.
    Travaille uniquement sur des bougies fermées.
    """
    n = len(df)
    search_start = max(SWING_LOOKBACK + 2, n - SWEEP_LOOKBACK_BARS)
    current_close = float(df.iloc[-1]["close"])

    # Scan de la barre la plus récente vers la plus ancienne
    for i in range(n - 2, search_start - 1, -1):
        bar = df.iloc[i]

        # ── Swing Low récent avant cette barre ────────────────────────────────
        sl_price = None
        for k in range(i - 1, max(i - SWEEP_LOOKBACK_BARS // 2, SWING_LOOKBACK) - 1, -1):
            if is_sl.iloc[k]:
                sl_price = float(df.iloc[k]["low"])
                break
        if sl_price is None:
            continue

        # ── Bullish Sweep : low < swing_low ET close > swing_low ──────────────
        if not (bar["low"] < sl_price and bar["close"] > sl_price):
            continue

        vol_avg = float(bar["volume_avg"]) if bar["volume_avg"] > 0 else 1.0
        sweep_vol_ratio = float(bar["volume"]) / vol_avg
        if sweep_vol_ratio < SWEEP_VOLUME_MULTIPLIER:
            continue

        sweep_wick = float(bar["low"])

        # ── Swing High récent (cible du MSS) ──────────────────────────────────
        sh_price = None
        for k in range(i, max(i - SWEEP_LOOKBACK_BARS // 2, SWING_LOOKBACK) - 1, -1):
            if is_sh.iloc[k]:
                sh_price = float(df.iloc[k]["high"])
                break
        if sh_price is None:
            continue

        # ── MSS : clôture impulsive au-dessus du swing high ───────────────────
        mss_idx = None
        mss_vol_ratio = 1.0
        fib_high = float(bar["high"])

        for j in range(i + MSS_MIN_BARS, min(i + MSS_MAX_BARS + 1, n)):
            jbar = df.iloc[j]
            fib_high = max(fib_high, float(jbar["high"]))
            if jbar["close"] > sh_price:
                jvol_avg = float(jbar["volume_avg"]) if jbar["volume_avg"] > 0 else 1.0
                jvol = float(jbar["volume"]) / jvol_avg
                if jvol >= MSS_VOLUME_MULTIPLIER:
                    mss_idx = j
                    mss_vol_ratio = jvol
                    break

        if mss_idx is None:
            continue

        # MSS trop vieux pour être encore tradeable
        if mss_idx < n - MSS_MAX_BARS:
            continue

        # ── Zone OTE ──────────────────────────────────────────────────────────
        ote_upper, ote_lower = _fib_long(sweep_wick, fib_high)
        ote_entry = (ote_upper + ote_lower) / 2

        # Signal envoyé uniquement si le prix est dans la zone OTE (±0.1%)
        tol = ote_upper * 0.001
        if not (ote_lower - tol <= current_close <= ote_upper + tol):
            continue

        # ── SL / TP ───────────────────────────────────────────────────────────
        sl = sweep_wick * (1 - SL_BUFFER_PCT / 100)
        risk = ote_entry - sl
        if risk <= 0:
            continue

        tp1 = ote_entry + TP1_RR * risk
        tp2 = ote_entry + TP2_RR * risk

        # ── Score ─────────────────────────────────────────────────────────────
        fib_range = ote_upper - ote_lower
        depth = (ote_upper - current_close) / fib_range if fib_range > 0 else 0.5
        atr_pct = float(df.iloc[-1]["atr"]) / current_close * 100
        sc = _score(sweep_vol_ratio, mss_vol_ratio, depth, atr_pct)
        if sc < MIN_SCORE:
            continue

        snap = MSSSnapshot(
            sweep_level=round(sl_price, 6),
            sweep_wick=round(sweep_wick, 6),
            mss_level=round(sh_price, 6),
            fib_high=round(fib_high, 6),
            fib_low=round(sweep_wick, 6),
            fib_618=round(ote_upper, 6),
            fib_786=round(ote_lower, 6),
            atr=round(float(df.iloc[-1]["atr"]), 6),
            sweep_vol_ratio=round(sweep_vol_ratio, 2),
            mss_vol_ratio=round(mss_vol_ratio, 2),
        )

        return Signal(
            symbol=symbol,
            side="LONG",
            entry=round(ote_entry, 6),
            ote_upper=round(ote_upper, 6),
            ote_lower=round(ote_lower, 6),
            sl=round(sl, 6),
            tp1=round(tp1, 6),
            tp2=round(tp2, 6),
            rr=round(TP2_RR, 2),
            score=sc,
            indicators=snap,
            timestamp=df.iloc[-1]["timestamp"].to_pydatetime(),
        )

    return None


# ─── Détection bearish ────────────────────────────────────────────────────────

def _find_bearish(
    df: pd.DataFrame,
    is_sh: pd.Series,
    is_sl: pd.Series,
    symbol: str,
) -> Optional[Signal]:
    """Miroir exact du bullish pour les setups SHORT."""
    n = len(df)
    search_start = max(SWING_LOOKBACK + 2, n - SWEEP_LOOKBACK_BARS)
    current_close = float(df.iloc[-1]["close"])

    for i in range(n - 2, search_start - 1, -1):
        bar = df.iloc[i]

        # Swing High récent
        sh_price = None
        for k in range(i - 1, max(i - SWEEP_LOOKBACK_BARS // 2, SWING_LOOKBACK) - 1, -1):
            if is_sh.iloc[k]:
                sh_price = float(df.iloc[k]["high"])
                break
        if sh_price is None:
            continue

        # Bearish Sweep : high > swing_high ET close < swing_high
        if not (bar["high"] > sh_price and bar["close"] < sh_price):
            continue

        vol_avg = float(bar["volume_avg"]) if bar["volume_avg"] > 0 else 1.0
        sweep_vol_ratio = float(bar["volume"]) / vol_avg
        if sweep_vol_ratio < SWEEP_VOLUME_MULTIPLIER:
            continue

        sweep_wick = float(bar["high"])

        # Swing Low récent (cible MSS baissier)
        sl_price = None
        for k in range(i, max(i - SWEEP_LOOKBACK_BARS // 2, SWING_LOOKBACK) - 1, -1):
            if is_sl.iloc[k]:
                sl_price = float(df.iloc[k]["low"])
                break
        if sl_price is None:
            continue

        # MSS baissier : clôture impulsive sous le swing low
        mss_idx = None
        mss_vol_ratio = 1.0
        fib_low = float(bar["low"])

        for j in range(i + MSS_MIN_BARS, min(i + MSS_MAX_BARS + 1, n)):
            jbar = df.iloc[j]
            fib_low = min(fib_low, float(jbar["low"]))
            if jbar["close"] < sl_price:
                jvol_avg = float(jbar["volume_avg"]) if jbar["volume_avg"] > 0 else 1.0
                jvol = float(jbar["volume"]) / jvol_avg
                if jvol >= MSS_VOLUME_MULTIPLIER:
                    mss_idx = j
                    mss_vol_ratio = jvol
                    break

        if mss_idx is None:
            continue
        if mss_idx < n - MSS_MAX_BARS:
            continue

        ote_upper, ote_lower = _fib_short(fib_low, sweep_wick)
        ote_entry = (ote_upper + ote_lower) / 2

        tol = ote_lower * 0.001
        if not (ote_lower - tol <= current_close <= ote_upper + tol):
            continue

        sl = sweep_wick * (1 + SL_BUFFER_PCT / 100)
        risk = sl - ote_entry
        if risk <= 0:
            continue

        tp1 = ote_entry - TP1_RR * risk
        tp2 = ote_entry - TP2_RR * risk

        fib_range = ote_upper - ote_lower
        depth = (current_close - ote_lower) / fib_range if fib_range > 0 else 0.5
        atr_pct = float(df.iloc[-1]["atr"]) / current_close * 100
        sc = _score(sweep_vol_ratio, mss_vol_ratio, depth, atr_pct)
        if sc < MIN_SCORE:
            continue

        snap = MSSSnapshot(
            sweep_level=round(sh_price, 6),
            sweep_wick=round(sweep_wick, 6),
            mss_level=round(sl_price, 6),
            fib_high=round(sweep_wick, 6),
            fib_low=round(fib_low, 6),
            fib_618=round(ote_lower, 6),
            fib_786=round(ote_upper, 6),
            atr=round(float(df.iloc[-1]["atr"]), 6),
            sweep_vol_ratio=round(sweep_vol_ratio, 2),
            mss_vol_ratio=round(mss_vol_ratio, 2),
        )

        return Signal(
            symbol=symbol,
            side="SHORT",
            entry=round(ote_entry, 6),
            ote_upper=round(ote_upper, 6),
            ote_lower=round(ote_lower, 6),
            sl=round(sl, 6),
            tp1=round(tp1, 6),
            tp2=round(tp2, 6),
            rr=round(TP2_RR, 2),
            score=sc,
            indicators=snap,
            timestamp=df.iloc[-1]["timestamp"].to_pydatetime(),
        )

    return None


# ─── Point d'entrée public ────────────────────────────────────────────────────

def evaluate(
    df_5m: pd.DataFrame,
    df_1m: pd.DataFrame,
    symbol: str,
) -> Optional[Signal]:
    """
    Fonction pure — appelée identiquement par live et backtest.
    Détecte Liquidity Sweep + MSS + prix en zone OTE.
    """
    if len(df_1m) < 60:
        return None

    # Bougies fermées uniquement → pas de repainting
    closed = df_1m.iloc[:-1]

    if "atr" not in closed.columns:
        closed = compute_all(closed.copy())
    else:
        closed = closed.copy()

    # Filtre volatilité
    last = closed.iloc[-1]
    if float(last["atr"]) / float(last["close"]) * 100 < MIN_ATR_PERCENT:
        return None

    # Pivots confirmés (derniers SWING_LOOKBACK bars = False → no lookahead)
    is_sh = find_swing_highs(closed, SWING_LOOKBACK)
    is_sl = find_swing_lows(closed, SWING_LOOKBACK)

    signal = _find_bullish(closed, is_sh, is_sl, symbol)
    if signal:
        return signal
    return _find_bearish(closed, is_sh, is_sl, symbol)
