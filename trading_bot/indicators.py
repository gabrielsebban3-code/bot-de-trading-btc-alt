"""
Indicateurs techniques : SMC (Order Blocks, FVG, BOS, CHOCH, Liquidity Sweeps)
+ EMA, RSI, Volume, ATR — calculés sur des DataFrames pandas
"""

import numpy as np
import pandas as pd
from ta.trend import EMAIndicator
from ta.momentum import RSIIndicator
from ta.volatility import AverageTrueRange

from config import (
    EMA_SHORT, EMA_MID, EMA_LONG,
    RSI_PERIOD, RSI_LONG_MIN, RSI_LONG_MAX, RSI_SHORT_MIN, RSI_SHORT_MAX,
    ATR_PERIOD, ATR_LOW_THRESHOLD, ATR_HIGH_THRESHOLD,
    VOLUME_SPIKE_MULTIPLIER, VOLUME_AVG_PERIOD,
    LIQUIDITY_TOLERANCE,
)


# ─────────────────────────────────────────────
# EMA
# ─────────────────────────────────────────────

def calculate_emas(df: pd.DataFrame) -> pd.DataFrame:
    """Calcule EMA 21, 50, 200 sur la colonne 'close'."""
    df = df.copy()
    df["ema21"] = EMAIndicator(df["close"], window=EMA_SHORT).ema_indicator()
    df["ema50"] = EMAIndicator(df["close"], window=EMA_MID).ema_indicator()
    df["ema200"] = EMAIndicator(df["close"], window=EMA_LONG).ema_indicator()
    return df


def ema_trend_direction(df: pd.DataFrame) -> str:
    """
    Retourne 'bullish', 'bearish' ou 'neutral' selon l'alignement des EMAs
    sur la dernière bougie.
    """
    last = df.iloc[-1]
    if last["close"] > last["ema21"] > last["ema50"] > last["ema200"]:
        return "bullish"
    if last["close"] < last["ema21"] < last["ema50"] < last["ema200"]:
        return "bearish"
    return "neutral"


# ─────────────────────────────────────────────
# RSI
# ─────────────────────────────────────────────

def calculate_rsi(df: pd.DataFrame) -> pd.DataFrame:
    """Calcule le RSI(14) sur la colonne 'close'."""
    df = df.copy()
    df["rsi"] = RSIIndicator(df["close"], window=RSI_PERIOD).rsi()
    return df


def rsi_signal(df: pd.DataFrame) -> str:
    """
    Retourne 'long', 'short' ou 'neutral' selon la zone RSI actuelle.
    """
    rsi_val = df["rsi"].iloc[-1]
    if RSI_LONG_MIN <= rsi_val <= RSI_LONG_MAX:
        return "long"
    if RSI_SHORT_MIN <= rsi_val <= RSI_SHORT_MAX:
        return "short"
    return "neutral"


def rsi_divergence(df: pd.DataFrame) -> str:
    """
    Détecte une divergence RSI vs price sur les 20 dernières bougies.
    Retourne 'bullish_div', 'bearish_div' ou 'none'.

    Correction : utilise dropna() pour éviter les NaN silencieux sur le RSI.
    """
    window = df.tail(20).dropna(subset=["rsi"])
    if len(window) < 5:
        return "none"

    closes = window["close"].values
    rsis = window["rsi"].values

    price_last = closes[-1]
    rsi_last = rsis[-1]

    # Divergence bullish : price fait new low mais RSI est plus haut qu'au précédent low
    low_idx = int(np.argmin(closes[:-1]))
    if price_last < closes[low_idx] and rsi_last > rsis[low_idx]:
        return "bullish_div"

    # Divergence bearish : price fait new high mais RSI est plus bas qu'au précédent high
    high_idx = int(np.argmax(closes[:-1]))
    if price_last > closes[high_idx] and rsi_last < rsis[high_idx]:
        return "bearish_div"

    return "none"


# ─────────────────────────────────────────────
# Volume
# ─────────────────────────────────────────────

def volume_spike(df: pd.DataFrame) -> bool:
    """
    Retourne True si le volume de la dernière bougie dépasse
    1.5x la moyenne des 20 dernières bougies.
    """
    if len(df) < VOLUME_AVG_PERIOD + 1:
        return False
    avg_vol = df["volume"].iloc[-(VOLUME_AVG_PERIOD + 1):-1].mean()
    current_vol = df["volume"].iloc[-1]
    return current_vol > avg_vol * VOLUME_SPIKE_MULTIPLIER


# ─────────────────────────────────────────────
# ATR
# ─────────────────────────────────────────────

def calculate_atr(df: pd.DataFrame) -> pd.DataFrame:
    """Calcule l'ATR(14)."""
    df = df.copy()
    df["atr"] = AverageTrueRange(
        df["high"], df["low"], df["close"], window=ATR_PERIOD
    ).average_true_range()
    return df


def atr_volatility_label(df: pd.DataFrame) -> str:
    """
    Classifie la volatilité : 'Low', 'Medium' ou 'High'
    basé sur ATR / prix en %.
    """
    last = df.iloc[-1]
    atr_pct = (last["atr"] / last["close"]) * 100
    if atr_pct < ATR_LOW_THRESHOLD:
        return "Low"
    if atr_pct > ATR_HIGH_THRESHOLD:
        return "High"
    return "Medium"


# ─────────────────────────────────────────────
# SMC — Order Blocks
# ─────────────────────────────────────────────

def _is_rejection_candle(open_: float, high: float, low: float, close: float) -> tuple[bool, bool]:
    """
    Détecte si une bougie est un OB valide, corps classique OU wick de rejet.

    Retourne (is_bearish_ob, is_bullish_ob).

    Bearish OB : corps bearish classique OU long wick haut (rejet du haut).
    Bullish OB : corps bullish classique OU long wick bas (rejet du bas).
    Le wick de rejet doit représenter > 60% de la taille totale de la bougie.
    """
    body = abs(close - open_)
    total = high - low
    if total == 0:
        return False, False

    upper_wick = high - max(open_, close)
    lower_wick = min(open_, close) - low

    # Corps bearish classique OU wick haut dominant (rejet haussier → zone de vente)
    is_bearish_ob = (close < open_) or (upper_wick / total > 0.60)

    # Corps bullish classique OU wick bas dominant (rejet baissier → zone d'achat)
    is_bullish_ob = (close > open_) or (lower_wick / total > 0.60)

    return is_bearish_ob, is_bullish_ob


def detect_order_blocks(df: pd.DataFrame) -> dict:
    """
    Détecte les Order Blocks bullish et bearish.

    Bullish OB = dernière bougie bearish (ou wick bas) avant impulsion bullish.
    Bearish OB = dernière bougie bullish (ou wick haut) avant impulsion bearish.

    Retourne un dict avec :
      - 'bullish_ob' : dict {high, low, index} ou None
      - 'bearish_ob' : dict {high, low, index} ou None
    """
    result = {"bullish_ob": None, "bearish_ob": None}

    if len(df) < 5:
        return result

    # Extraction une seule fois pour éviter les accès répétés
    closes = df["close"].values
    opens = df["open"].values
    highs = df["high"].values
    lows = df["low"].values

    lookback = min(50, len(df) - 2)

    for i in range(len(df) - 2, len(df) - 2 - lookback, -1):
        if i < 1:
            break

        is_bearish_candle, is_bullish_candle = _is_rejection_candle(
            opens[i], highs[i], lows[i], closes[i]
        )

        # Bougie bearish/rejet haut + impulsion bullish → Bullish OB
        next_is_bullish_impulse = closes[i + 1] > highs[i]
        if is_bearish_candle and next_is_bullish_impulse and result["bullish_ob"] is None:
            result["bullish_ob"] = {"high": highs[i], "low": lows[i], "index": i}

        # Bougie bullish/rejet bas + impulsion bearish → Bearish OB
        next_is_bearish_impulse = closes[i + 1] < lows[i]
        if is_bullish_candle and next_is_bearish_impulse and result["bearish_ob"] is None:
            result["bearish_ob"] = {"high": highs[i], "low": lows[i], "index": i}

        if result["bullish_ob"] and result["bearish_ob"]:
            break

    return result


def price_in_order_block(current_price: float, ob: dict) -> bool:
    """Retourne True si le prix actuel est dans la zone de l'Order Block."""
    if ob is None:
        return False
    return ob["low"] <= current_price <= ob["high"]


# ─────────────────────────────────────────────
# SMC — Fair Value Gap (FVG)
# ─────────────────────────────────────────────

def detect_fvg(df: pd.DataFrame) -> dict:
    """
    Détecte les Fair Value Gaps (pattern 3 bougies).

    Bullish FVG : gap entre high[i-2] et low[i] — gap haussier non comblé.
    Bearish FVG : gap entre low[i-2] et high[i] — gap baissier non comblé.

    Retourne le FVG le plus récent de chaque type :
      - 'bullish_fvg' : dict {high, low, index} ou None
      - 'bearish_fvg' : dict {high, low, index} ou None
    """
    result = {"bullish_fvg": None, "bearish_fvg": None}

    if len(df) < 3:
        return result

    highs = df["high"].values
    lows = df["low"].values
    lookback = min(50, len(df) - 2)

    for i in range(len(df) - 1, len(df) - 1 - lookback, -1):
        if i < 2:
            break

        if lows[i] > highs[i - 2] and result["bullish_fvg"] is None:
            result["bullish_fvg"] = {
                "high": lows[i],
                "low": highs[i - 2],
                "index": i,
            }

        if highs[i] < lows[i - 2] and result["bearish_fvg"] is None:
            result["bearish_fvg"] = {
                "high": lows[i - 2],
                "low": highs[i],
                "index": i,
            }

        if result["bullish_fvg"] and result["bearish_fvg"]:
            break

    return result


def price_in_fvg(current_price: float, fvg: dict) -> bool:
    """Retourne True si le prix actuel retrace dans le FVG."""
    if fvg is None:
        return False
    return fvg["low"] <= current_price <= fvg["high"]


# ─────────────────────────────────────────────
# SMC — BOS & CHOCH
# ─────────────────────────────────────────────

def detect_bos_choch(df: pd.DataFrame) -> dict:
    """
    Détecte BOS (Break of Structure) et CHOCH (Change of Character).

    BOS bullish = nouveau Higher High confirmé (close > précédent swing high).
    BOS bearish = nouveau Lower Low confirmé (close < précédent swing low).
    CHOCH = premier BOS dans la direction opposée à la structure en cours.

    Retourne :
      - 'bos_bullish'  : bool
      - 'bos_bearish'  : bool
      - 'choch_bullish': bool
      - 'choch_bearish': bool
      - 'trend'        : 'bullish' | 'bearish' | 'neutral'
    """
    result = {
        "bos_bullish": False,
        "bos_bearish": False,
        "choch_bullish": False,
        "choch_bearish": False,
        "trend": "neutral",
    }

    if len(df) < 10:
        return result

    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values

    lookback = min(30, len(df) - 1)
    recent_highs = highs[-lookback:]
    recent_lows = lows[-lookback:]

    prev_swing_high = np.max(recent_highs[:-3])
    prev_swing_low = np.min(recent_lows[:-3])
    current_close = closes[-1]

    if current_close > prev_swing_high:
        result["bos_bullish"] = True
        result["trend"] = "bullish"
    elif current_close < prev_swing_low:
        result["bos_bearish"] = True
        result["trend"] = "bearish"

    if lookback >= 15:
        mid = lookback // 2
        was_bullish = np.max(highs[-mid:]) > np.max(highs[-lookback:-mid])
        was_bearish = np.min(lows[-mid:]) < np.min(lows[-lookback:-mid])

        if was_bearish and result["bos_bullish"]:
            result["choch_bullish"] = True
        if was_bullish and result["bos_bearish"]:
            result["choch_bearish"] = True

    return result


# ─────────────────────────────────────────────
# SMC — Liquidity Sweeps
# ─────────────────────────────────────────────

def detect_liquidity_sweep(df: pd.DataFrame) -> dict:
    """
    Détecte les liquidity sweeps.

    Equal highs/lows dans une tolérance de 0.15%, suivis d'une réaction inverse.
    Optimisation : comparaison vectorielle numpy au lieu de double boucle O(n²).

    Retourne :
      - 'bullish_sweep' : bool (sweep de lows → réaction haussière)
      - 'bearish_sweep' : bool (sweep de highs → réaction baissière)
      - 'sweep_level'   : float ou None
    """
    result = {"bullish_sweep": False, "bearish_sweep": False, "sweep_level": None}

    if len(df) < 5:
        return result

    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values

    lookback = min(30, len(df) - 2)
    current_close = closes[-1]
    current_high = highs[-1]
    current_low = lows[-1]

    # Fenêtre de recherche (exclut la dernière bougie)
    search_lows = lows[-(lookback + 1):-1]
    search_highs = highs[-(lookback + 1):-1]

    # ── Equal lows : comparaison vectorielle ─────────────────────────────────
    # Pour chaque bougie i, cherche si un autre low dans les 10 bougies avant
    # est à moins de LIQUIDITY_TOLERANCE de distance
    for i in range(len(search_lows) - 1, 0, -1):
        window = search_lows[max(0, i - 10):i]
        if len(window) == 0:
            continue
        diffs = np.abs(search_lows[i] - window) / search_lows[i]
        if np.any(diffs <= LIQUIDITY_TOLERANCE):
            if current_low < search_lows[i] and current_close > search_lows[i]:
                result["bullish_sweep"] = True
                result["sweep_level"] = float(search_lows[i])
                return result

    # ── Equal highs : comparaison vectorielle ────────────────────────────────
    for i in range(len(search_highs) - 1, 0, -1):
        window = search_highs[max(0, i - 10):i]
        if len(window) == 0:
            continue
        diffs = np.abs(search_highs[i] - window) / search_highs[i]
        if np.any(diffs <= LIQUIDITY_TOLERANCE):
            if current_high > search_highs[i] and current_close < search_highs[i]:
                result["bearish_sweep"] = True
                result["sweep_level"] = float(search_highs[i])
                return result

    return result


# ─────────────────────────────────────────────
# Biais directionnel par timeframe
# ─────────────────────────────────────────────

def get_tf_bias(df: pd.DataFrame, df_has_emas: bool = False) -> str:
    """
    Détermine le biais directionnel d'un timeframe : 'bullish', 'bearish' ou 'neutral'.
    Basé sur l'alignement EMA + BOS.

    df_has_emas : True si les EMAs sont déjà calculées dans df (évite le double calcul).
    """
    if not df_has_emas:
        df = calculate_emas(df)
    ema_dir = ema_trend_direction(df)
    bos = detect_bos_choch(df)

    if ema_dir == "bullish" and (bos["bos_bullish"] or bos["trend"] == "bullish"):
        return "bullish"
    if ema_dir == "bearish" and (bos["bos_bearish"] or bos["trend"] == "bearish"):
        return "bearish"
    if ema_dir == "bullish":
        return "bullish"
    if ema_dir == "bearish":
        return "bearish"
    return "neutral"
