"""
Trend-Pullback Scalper — logique de signal PARTAGÉE entre live et backtest.
Une seule fonction publique : evaluate(df_5m, df_1m, symbol) → Signal | None.
NE PAS dupliquer cette logique ailleurs.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import pandas as pd

from strategy.config import (
    ATR_MULTIPLIER,
    MIN_ATR_PERCENT,
    PULLBACK_PROXIMITY_PCT,
    RISK_REWARD_MIN,
    RSI_CROSS_LEVEL,
    RSI_LOOKBACK,
    RSI_OVERBOUGHT,
    RSI_OVERSOLD,
    VOLUME_MULTIPLIER,
)
from strategy.indicators import compute_all

logger = logging.getLogger(__name__)


# ─── Types de données ─────────────────────────────────────────────────────────

@dataclass
class IndicatorsSnapshot:
    """Capture des valeurs d'indicateurs au moment du signal (pour les logs/Discord)."""
    ema9_5m: float
    ema21_5m: float
    ema50_5m: float
    vwap_5m: float
    atr_5m: float
    rsi_1m: float
    macd_hist_1m: float
    volume_ratio: float  # volume_bougie / volume_moyen


@dataclass
class Signal:
    """Objet signal renvoyé par evaluate(). Immuable côté stratégie."""
    symbol: str
    side: str          # "LONG" ou "SHORT"
    entry: float       # prix d'entrée suggéré (close de la bougie déclencheur)
    sl: float          # stop-loss
    tp1: float         # take-profit 1 (1R)
    tp2: float         # take-profit 2 (2R)
    rr: float          # risk-reward effectif (tp2 / risque)
    score: int         # 0-100 : confiance du signal
    indicators: IndicatorsSnapshot
    timestamp: datetime
    timeframe_bias: str = "5m"
    timeframe_entry: str = "1m"
    # Champs calculés automatiquement
    risk: float = field(init=False)

    def __post_init__(self) -> None:
        self.risk = abs(self.entry - self.sl)


# ─── Helpers internes ─────────────────────────────────────────────────────────

def _near(price: float, level: float, pct: float) -> bool:
    """Vrai si price est dans ±pct % de level."""
    return abs(price - level) / level * 100 <= pct


def _rsi_crossed(rsi_series: pd.Series, oversold: float, cross_level: float) -> bool:
    """
    Long : RSI est passé sous oversold dans les N dernières bougies,
    puis la bougie actuelle est au-dessus de cross_level.
    """
    lookback = rsi_series.iloc[-RSI_LOOKBACK - 1 : -1]  # bougies précédentes
    current = rsi_series.iloc[-1]
    return bool((lookback < oversold).any() and current > cross_level)


def _rsi_crossed_down(rsi_series: pd.Series, overbought: float, cross_level: float) -> bool:
    """Short : RSI est passé au-dessus de overbought puis recroise sous cross_level."""
    lookback = rsi_series.iloc[-RSI_LOOKBACK - 1 : -1]
    current = rsi_series.iloc[-1]
    return bool((lookback > overbought).any() and current < cross_level)


def _score_signal(conditions_met: int, total_conditions: int, volume_ratio: float) -> int:
    """
    Score de confiance 0-100 :
    - 70 points pour le ratio conditions remplies / total
    - 30 points pour la force du volume (plafonné à 3× le volume moyen)
    """
    base = int((conditions_met / total_conditions) * 70)
    vol_bonus = int(min((volume_ratio - 1.0) / 2.0, 1.0) * 30)
    return max(0, min(100, base + vol_bonus))


# ─── Filtre de biais 5m ───────────────────────────────────────────────────────

def _get_bias_5m(df5: pd.DataFrame) -> Optional[str]:
    """
    Retourne 'LONG', 'SHORT' ou None (range/ATR trop faible).
    Utilise la dernière bougie clôturée (iloc[-2] pour éviter la bougie en cours).
    """
    row = df5.iloc[-2]  # dernière bougie fermée

    # Filtre volatilité : marché trop mort → skip
    atr_pct = row["atr"] / row["close"] * 100
    if atr_pct < MIN_ATR_PERCENT:
        return None

    ema9, ema21, ema50 = row["ema9"], row["ema21"], row["ema50"]
    close, vwap = row["close"], row["vwap"]

    if ema9 > ema21 > ema50 and close > vwap:
        return "LONG"
    if ema9 < ema21 < ema50 and close < vwap:
        return "SHORT"
    return None  # range


# ─── Déclencheur d'entrée 1m ─────────────────────────────────────────────────

def _check_long_trigger(df1: pd.DataFrame) -> tuple[bool, int, int]:
    """
    Vérifie les 5 conditions du déclencheur long sur la dernière bougie 1m.
    Retourne (signal_valide, nb_conditions_remplies, nb_total_conditions).
    """
    total = 5
    row = df1.iloc[-1]   # bougie déclencheur (dernière fermée)
    prev = df1.iloc[-2]

    met = 0

    # 1. Pullback : le low a touché l'EMA21 ou la VWAP
    pullback = _near(row["low"], row["ema21"], PULLBACK_PROXIMITY_PCT) or \
               _near(row["low"], row["vwap"], PULLBACK_PROXIMITY_PCT)
    if pullback:
        met += 1

    # 2. RSI : passé sous oversold dans le lookback, puis > 50 maintenant
    rsi_ok = _rsi_crossed(df1["rsi"], RSI_OVERSOLD, RSI_CROSS_LEVEL)
    if rsi_ok:
        met += 1

    # 3. Bougie haussière et clôture au-dessus de l'EMA9
    bullish_candle = row["close"] > row["open"] and row["close"] > row["ema9"]
    if bullish_candle:
        met += 1

    # 4. Volume > VOLUME_MULTIPLIER × volume moyen
    volume_ratio = row["volume"] / row["volume_avg"] if row["volume_avg"] > 0 else 0
    if volume_ratio >= VOLUME_MULTIPLIER:
        met += 1

    # 5. Histogramme MACD en hausse (momentum positif croissant)
    macd_rising = row["macd_hist"] > prev["macd_hist"] and row["macd_hist"] > 0
    if macd_rising:
        met += 1

    # Toutes les conditions doivent être remplies pour un signal valide
    return met == total, met, total


def _check_short_trigger(df1: pd.DataFrame) -> tuple[bool, int, int]:
    """Miroir exact du long pour les shorts."""
    total = 5
    row = df1.iloc[-1]
    prev = df1.iloc[-2]

    met = 0

    # 1. Pullback haussier (retracement vers résistance) : high proche EMA21 ou VWAP
    pullback = _near(row["high"], row["ema21"], PULLBACK_PROXIMITY_PCT) or \
               _near(row["high"], row["vwap"], PULLBACK_PROXIMITY_PCT)
    if pullback:
        met += 1

    # 2. RSI : passé au-dessus de overbought, puis < 50 maintenant
    rsi_ok = _rsi_crossed_down(df1["rsi"], RSI_OVERBOUGHT, RSI_CROSS_LEVEL)
    if rsi_ok:
        met += 1

    # 3. Bougie baissière et clôture sous l'EMA9
    bearish_candle = row["close"] < row["open"] and row["close"] < row["ema9"]
    if bearish_candle:
        met += 1

    # 4. Volume > VOLUME_MULTIPLIER × volume moyen
    volume_ratio = row["volume"] / row["volume_avg"] if row["volume_avg"] > 0 else 0
    if volume_ratio >= VOLUME_MULTIPLIER:
        met += 1

    # 5. Histogramme MACD en baisse (momentum négatif croissant)
    macd_falling = row["macd_hist"] < prev["macd_hist"] and row["macd_hist"] < 0
    if macd_falling:
        met += 1

    return met == total, met, total


# ─── Calcul des niveaux de risque ────────────────────────────────────────────

def _build_signal(
    symbol: str,
    side: str,
    df1: pd.DataFrame,
    df5: pd.DataFrame,
    met: int,
    total: int,
) -> Optional[Signal]:
    """
    Calcule SL, TP1, TP2, R:R et construit l'objet Signal.
    Retourne None si R:R < RISK_REWARD_MIN.
    """
    row1 = df1.iloc[-1]
    row5 = df5.iloc[-2]

    entry = float(row1["close"])
    atr = float(row1["atr"])
    risk_dist = ATR_MULTIPLIER * atr  # distance SL en points

    if side == "LONG":
        sl = entry - risk_dist
        tp1 = entry + risk_dist       # 1R
        tp2 = entry + 2 * risk_dist   # 2R
    else:
        sl = entry + risk_dist
        tp1 = entry - risk_dist
        tp2 = entry - 2 * risk_dist

    rr = abs(tp2 - entry) / abs(entry - sl)

    # N'émettre le signal que si R:R ≥ seuil minimum
    if rr < RISK_REWARD_MIN:
        logger.debug("%s %s : R:R %.2f < %.2f → skip", symbol, side, rr, RISK_REWARD_MIN)
        return None

    volume_ratio = float(row1["volume"] / row1["volume_avg"]) if row1["volume_avg"] > 0 else 1.0
    score = _score_signal(met, total, volume_ratio)

    snapshot = IndicatorsSnapshot(
        ema9_5m=float(row5["ema9"]),
        ema21_5m=float(row5["ema21"]),
        ema50_5m=float(row5["ema50"]),
        vwap_5m=float(row5["vwap"]),
        atr_5m=float(row5["atr"]),
        rsi_1m=float(row1["rsi"]),
        macd_hist_1m=float(row1["macd_hist"]),
        volume_ratio=volume_ratio,
    )

    return Signal(
        symbol=symbol,
        side=side,
        entry=round(entry, 6),
        sl=round(sl, 6),
        tp1=round(tp1, 6),
        tp2=round(tp2, 6),
        rr=round(rr, 2),
        score=score,
        indicators=snapshot,
        timestamp=pd.Timestamp.utcnow().to_pydatetime(),
    )


# ─── Point d'entrée public ────────────────────────────────────────────────────

def evaluate(
    df_5m: pd.DataFrame,
    df_1m: pd.DataFrame,
    symbol: str,
) -> Optional[Signal]:
    """
    Fonction pure principale — appelée identiquement par le live ET le backtest.

    Paramètres
    ----------
    df_5m : DataFrame OHLCV + indicateurs pré-calculés (compute_all appliqué)
    df_1m : DataFrame OHLCV + indicateurs pré-calculés
    symbol : ex. "BTC/USDT"

    Retourne
    --------
    Signal si toutes les conditions sont réunies, None sinon.
    """
    # Garde-fous : données insuffisantes
    if len(df_5m) < 60 or len(df_1m) < 60:
        return None

    # S'assurer que les indicateurs sont calculés
    if "ema9" not in df_5m.columns:
        df_5m = compute_all(df_5m)
    if "ema9" not in df_1m.columns:
        df_1m = compute_all(df_1m)

    # Étape 1 : filtre de biais directionnel sur 5m
    bias = _get_bias_5m(df_5m)
    if bias is None:
        return None  # range ou marché trop calme

    # Étape 2 : déclencheur d'entrée sur 1m
    if bias == "LONG":
        valid, met, total = _check_long_trigger(df_1m)
    else:
        valid, met, total = _check_short_trigger(df_1m)

    if not valid:
        return None

    # Étape 3 : construction du signal avec niveaux de risque
    return _build_signal(symbol, bias, df_1m, df_5m, met, total)
