"""
indicators.py — Tous les calculs d'analyse technique.

Contient :
  - EMA (21 / 50 / 200) et alignement de tendance
  - RSI (14) + détection de divergences
  - ATR (14) + classification de volatilité
  - Volume (moyenne + détection de spike)
  - Smart Money Concepts : Order Blocks, Fair Value Gaps, BOS / CHOCH,
    sweeps de liquidité (equal highs / lows)

Toutes les fonctions travaillent sur un DataFrame pandas avec les colonnes :
    ['timestamp', 'open', 'high', 'low', 'close', 'volume']
"""

from __future__ import annotations

import pandas as pd

import config


# ===========================================================================
# INDICATEURS CLASSIQUES
# ===========================================================================
def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential Moving Average."""
    return series.ewm(span=period, adjust=False).mean()


def add_emas(df: pd.DataFrame) -> pd.DataFrame:
    """Ajoute les colonnes ema_21 / ema_50 / ema_200."""
    for period in config.EMA_PERIODS:
        df[f"ema_{period}"] = ema(df["close"], period)
    return df


def ema_alignment(df: pd.DataFrame) -> str:
    """
    Retourne 'bullish', 'bearish' ou 'neutral' selon l'alignement
    prix > EMA21 > EMA50 > EMA200 (haussier) ou l'inverse (baissier).
    """
    last = df.iloc[-1]
    p = last["close"]
    e21, e50, e200 = last["ema_21"], last["ema_50"], last["ema_200"]

    if pd.isna(e200):
        return "neutral"

    if p > e21 > e50 > e200:
        return "bullish"
    if p < e21 < e50 < e200:
        return "bearish"
    return "neutral"


def rsi(series: pd.Series, period: int = config.RSI_PERIOD) -> pd.Series:
    """Relative Strength Index (méthode Wilder)."""
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def atr(df: pd.DataFrame, period: int = config.ATR_PERIOD) -> pd.Series:
    """Average True Range."""
    high_low = df["high"] - df["low"]
    high_close = (df["high"] - df["close"].shift()).abs()
    low_close = (df["low"] - df["close"].shift()).abs()
    true_range = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    return true_range.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def classify_volatility(df: pd.DataFrame) -> str:
    """Classe la volatilité (Low / Medium / High) via ATR / prix."""
    atr_series = atr(df)
    last_atr = atr_series.iloc[-1]
    last_price = df["close"].iloc[-1]
    if pd.isna(last_atr) or last_price == 0:
        return "Medium"

    ratio = last_atr / last_price
    if ratio < config.ATR_LOW_THRESHOLD:
        return "Low"
    if ratio > config.ATR_HIGH_THRESHOLD:
        return "High"
    return "Medium"


def volume_spike(df: pd.DataFrame) -> bool:
    """La dernière bougie dépasse-t-elle X fois la moyenne de volume ?"""
    vol_ma = df["volume"].rolling(config.VOLUME_MA_PERIOD).mean()
    last_vol = df["volume"].iloc[-1]
    avg_vol = vol_ma.iloc[-1]
    if pd.isna(avg_vol) or avg_vol == 0:
        return False
    return last_vol > config.VOLUME_SPIKE_MULTIPLIER * avg_vol


# ===========================================================================
# DIVERGENCES RSI
# ===========================================================================
def _last_two_extrema(values: pd.Series, lookback: int, find_high: bool):
    """
    Renvoie les indices (positions) des deux derniers extrema locaux
    (pivots) sur la fenêtre `lookback`. Pivot = plus haut/bas local
    avec 2 bougies de chaque côté.
    """
    window = values.iloc[-lookback:]
    idxs = []
    arr = window.values
    for i in range(2, len(arr) - 2):
        if find_high:
            if arr[i] > arr[i - 1] and arr[i] > arr[i - 2] and arr[i] > arr[i + 1] and arr[i] > arr[i + 2]:
                idxs.append(window.index[i])
        else:
            if arr[i] < arr[i - 1] and arr[i] < arr[i - 2] and arr[i] < arr[i + 1] and arr[i] < arr[i + 2]:
                idxs.append(window.index[i])
    return idxs[-2:] if len(idxs) >= 2 else []


def rsi_divergence(df: pd.DataFrame, rsi_series: pd.Series, lookback: int = 50) -> str:
    """
    Détecte une divergence RSI vs prix.
      - 'bullish' : prix fait un plus bas plus bas, RSI un plus bas plus haut
      - 'bearish' : prix fait un plus haut plus haut, RSI un plus haut plus bas
      - 'none' sinon
    """
    if len(df) < lookback:
        return "none"

    # Divergence haussière : sur les lows
    low_pivots = _last_two_extrema(df["low"], lookback, find_high=False)
    if len(low_pivots) == 2:
        p1, p2 = low_pivots
        if df["low"][p2] < df["low"][p1] and rsi_series[p2] > rsi_series[p1]:
            return "bullish"

    # Divergence baissière : sur les highs
    high_pivots = _last_two_extrema(df["high"], lookback, find_high=True)
    if len(high_pivots) == 2:
        p1, p2 = high_pivots
        if df["high"][p2] > df["high"][p1] and rsi_series[p2] < rsi_series[p1]:
            return "bearish"

    return "none"


# ===========================================================================
# SMART MONEY CONCEPTS
# ===========================================================================
def find_swing_points(df: pd.DataFrame, left: int = 2, right: int = 2):
    """
    Identifie les swing highs / lows (pivots).
    Retourne deux listes de tuples (index_position, prix).
    """
    highs, lows = [], []
    h = df["high"].values
    l = df["low"].values
    for i in range(left, len(df) - right):
        if all(h[i] >= h[i - j] for j in range(1, left + 1)) and all(
            h[i] >= h[i + j] for j in range(1, right + 1)
        ):
            highs.append((i, h[i]))
        if all(l[i] <= l[i - j] for j in range(1, left + 1)) and all(
            l[i] <= l[i + j] for j in range(1, right + 1)
        ):
            lows.append((i, l[i]))
    return highs, lows


def detect_bos(df: pd.DataFrame) -> str:
    """
    Break of Structure :
      - 'bullish' : clôture au-dessus du dernier swing high
      - 'bearish' : clôture sous le dernier swing low
      - 'none' sinon
    """
    highs, lows = find_swing_points(df)
    last_close = df["close"].iloc[-1]

    bos = "none"
    if highs:
        # On ignore les pivots tout récents (right buffer) pour éviter le bruit
        last_swing_high = highs[-1][1]
        if last_close > last_swing_high:
            bos = "bullish"
    if lows:
        last_swing_low = lows[-1][1]
        if last_close < last_swing_low:
            bos = "bearish"
    return bos


def detect_choch(df: pd.DataFrame) -> str:
    """
    Change of Character : premier BOS dans le sens opposé à la tendance EMA.
    Retourne 'bullish', 'bearish' ou 'none'.
    """
    trend = ema_alignment(df)
    bos = detect_bos(df)
    if trend == "bearish" and bos == "bullish":
        return "bullish"
    if trend == "bullish" and bos == "bearish":
        return "bearish"
    return "none"


def find_order_blocks(df: pd.DataFrame, impulse_lookback: int = 30):
    """
    Détecte le dernier Order Block haussier et baissier.

    Bullish OB : dernière bougie baissière avant une impulsion haussière.
    Bearish OB : dernière bougie haussière avant une impulsion baissière.

    Retourne un dict :
      {
        'bullish': {'high':..., 'low':..., 'index':...} | None,
        'bearish': {'high':..., 'low':..., 'index':...} | None,
      }
    """
    result = {"bullish": None, "bearish": None}
    n = len(df)
    start = max(1, n - impulse_lookback)

    o = df["open"].values
    c = df["close"].values
    h = df["high"].values
    l = df["low"].values

    for i in range(start, n - 1):
        is_bearish_candle = c[i] < o[i]
        is_bullish_candle = c[i] > o[i]
        next_is_bullish_impulse = c[i + 1] > h[i]   # impulsion qui dépasse le high
        next_is_bearish_impulse = c[i + 1] < l[i]   # impulsion qui casse le low

        if is_bearish_candle and next_is_bullish_impulse:
            result["bullish"] = {"high": h[i], "low": l[i], "index": i}
        if is_bullish_candle and next_is_bearish_impulse:
            result["bearish"] = {"high": h[i], "low": l[i], "index": i}

    return result


def find_fvg(df: pd.DataFrame, lookback: int = 30):
    """
    Détecte les Fair Value Gaps (imbalance 3 bougies).

    Bullish FVG : low[i] > high[i-2]  (gap haussier entre bougie 1 et 3)
    Bearish FVG : high[i] < low[i-2]  (gap baissier)

    Retourne le dernier FVG haussier et baissier sous forme de dict
    {'top':..., 'bottom':..., 'index':...} ou None.
    """
    result = {"bullish": None, "bearish": None}
    n = len(df)
    h = df["high"].values
    l = df["low"].values
    start = max(2, n - lookback)

    for i in range(start, n):
        # Bullish FVG
        if l[i] > h[i - 2]:
            result["bullish"] = {"top": l[i], "bottom": h[i - 2], "index": i}
        # Bearish FVG
        if h[i] < l[i - 2]:
            result["bearish"] = {"top": l[i - 2], "bottom": h[i], "index": i}

    return result


def price_in_zone(price: float, low: float, high: float) -> bool:
    """Le prix est-il à l'intérieur d'une zone [low, high] ?"""
    return low <= price <= high


def detect_liquidity_sweep(df: pd.DataFrame, lookback: int = 40):
    """
    Détecte un sweep de liquidité : des equal highs / lows
    (à `EQUAL_LEVEL_TOLERANCE` près) qui sont balayés puis suivis d'un rejet.

    Retourne 'bullish' (sweep de lows -> reversal haussier),
    'bearish' (sweep de highs -> reversal baissier) ou 'none'.
    """
    if len(df) < lookback + 2:
        return "none"

    window = df.iloc[-lookback:]
    tol = config.EQUAL_LEVEL_TOLERANCE
    last = df.iloc[-1]
    prev = df.iloc[-2]

    # Equal highs : deux highs proches dans la fenêtre (hors 2 dernières bougies)
    highs = window["high"].iloc[:-2]
    lows = window["low"].iloc[:-2]

    # Sweep baissier : on dépasse un equal-high puis on clôture en dessous
    eq_high_level = highs.max()
    if not pd.isna(eq_high_level):
        near_equal_highs = highs[(highs >= eq_high_level * (1 - tol))]
        if len(near_equal_highs) >= 2:
            if prev["high"] > eq_high_level and last["close"] < eq_high_level:
                return "bearish"

    # Sweep haussier : on casse un equal-low puis on clôture au-dessus
    eq_low_level = lows.min()
    if not pd.isna(eq_low_level):
        near_equal_lows = lows[(lows <= eq_low_level * (1 + tol))]
        if len(near_equal_lows) >= 2:
            if prev["low"] < eq_low_level and last["close"] > eq_low_level:
                return "bullish"

    return "none"


# ===========================================================================
# AGRÉGATION : ANALYSE COMPLÈTE D'UN TIMEFRAME
# ===========================================================================
def analyze_timeframe(df: pd.DataFrame) -> dict:
    """
    Calcule tous les indicateurs pertinents pour un DataFrame d'un timeframe
    et renvoie un dictionnaire de résultats normalisés.
    """
    df = df.copy()
    df = add_emas(df)
    rsi_series = rsi(df["close"])

    return {
        "close": float(df["close"].iloc[-1]),
        "ema_trend": ema_alignment(df),
        "rsi": float(rsi_series.iloc[-1]) if not pd.isna(rsi_series.iloc[-1]) else None,
        "rsi_divergence": rsi_divergence(df, rsi_series),
        "atr_volatility": classify_volatility(df),
        "volume_spike": volume_spike(df),
        "bos": detect_bos(df),
        "choch": detect_choch(df),
        "order_blocks": find_order_blocks(df),
        "fvg": find_fvg(df),
        "liquidity_sweep": detect_liquidity_sweep(df),
        "df": df,  # conservé pour le calcul SL/TP
    }
