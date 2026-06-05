"""
indicators.py
=============
All technical-analysis primitives used by the bot:

    * Classic indicators : EMA, RSI, ATR, volume MA / spike
    * Smart Money Concepts : Order Blocks, Fair Value Gaps,
      BOS, CHOCH, liquidity sweeps, RSI divergence

Every function operates on a pandas DataFrame with the canonical OHLCV
columns: ``open``, ``high``, ``low``, ``close``, ``volume`` indexed by an
ascending integer / time order (oldest first, newest last).

The functions are deliberately dependency-light (pandas + numpy only) so the
bot stays portable.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np
import pandas as pd

import config

Direction = Literal["bullish", "bearish"]


# --------------------------------------------------------------------------- #
# Classic indicators
# --------------------------------------------------------------------------- #
def ema(series: pd.Series, period: int) -> pd.Series:
    """Exponential moving average."""
    return series.ewm(span=period, adjust=False).mean()


def rsi(series: pd.Series, period: int = config.RSI_PERIOD) -> pd.Series:
    """Wilder's RSI."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)

    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    out = 100 - (100 / (1 + rs))
    # When avg_loss is 0 the asset is maximally overbought -> RSI 100.
    out = out.where(avg_loss != 0, 100.0)
    return out


def atr(df: pd.DataFrame, period: int = config.ATR_PERIOD) -> pd.Series:
    """Average True Range (Wilder)."""
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            (high - low),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def volume_ma(series: pd.Series, period: int = config.VOLUME_MA_PERIOD) -> pd.Series:
    """Simple moving average of volume."""
    return series.rolling(window=period, min_periods=1).mean()


def volume_spike(df: pd.DataFrame, multiplier: float = config.VOLUME_SPIKE_MULTIPLIER) -> bool:
    """True when the last (entry) candle volume exceeds ``multiplier`` x the MA."""
    vols = df["volume"]
    if len(vols) < 2:
        return False
    avg = volume_ma(vols).iloc[-2]  # average up to the previous candle
    if avg <= 0 or np.isnan(avg):
        return False
    return bool(vols.iloc[-1] > multiplier * avg)


# --------------------------------------------------------------------------- #
# EMA trend filter
# --------------------------------------------------------------------------- #
def ema_alignment(df: pd.DataFrame) -> Optional[Direction]:
    """
    Return ``"bullish"`` when price > EMA21 > EMA50 > EMA200,
    ``"bearish"`` when price < EMA21 < EMA50 < EMA200, else ``None``.
    """
    if len(df) < config.EMA_PERIODS[-1]:
        return None
    p21, p50, p200 = config.EMA_PERIODS
    close = df["close"]
    e21 = ema(close, p21).iloc[-1]
    e50 = ema(close, p50).iloc[-1]
    e200 = ema(close, p200).iloc[-1]
    price = close.iloc[-1]

    if price > e21 > e50 > e200:
        return "bullish"
    if price < e21 < e50 < e200:
        return "bearish"
    return None


# --------------------------------------------------------------------------- #
# Smart Money Concepts — structure helpers
# --------------------------------------------------------------------------- #
def _swing_points(df: pd.DataFrame, left: int = 2, right: int = 2) -> pd.DataFrame:
    """
    Flag swing highs / lows using a simple fractal definition: a candle whose
    high (low) is the highest (lowest) of the ``left`` candles before and
    ``right`` candles after it.

    Returns a copy of ``df`` with boolean ``swing_high`` / ``swing_low`` cols.
    """
    out = df.copy()
    highs, lows = out["high"].values, out["low"].values
    n = len(out)
    sh = np.zeros(n, dtype=bool)
    sl = np.zeros(n, dtype=bool)
    for i in range(left, n - right):
        window_h = highs[i - left : i + right + 1]
        window_l = lows[i - left : i + right + 1]
        if highs[i] == window_h.max() and (window_h.argmax() == left):
            sh[i] = True
        if lows[i] == window_l.min() and (window_l.argmin() == left):
            sl[i] = True
    out["swing_high"] = sh
    out["swing_low"] = sl
    return out


@dataclass
class Zone:
    """A price zone (e.g. Order Block or FVG) with [low, high] bounds."""

    low: float
    high: float
    direction: Direction
    kind: str          # "OB" | "FVG"
    index: int         # candle index where the zone originates

    def contains(self, price: float) -> bool:
        return self.low <= price <= self.high

    def midpoint(self) -> float:
        return (self.low + self.high) / 2.0


# --------------------------------------------------------------------------- #
# Order Blocks
# --------------------------------------------------------------------------- #
def find_order_blocks(df: pd.DataFrame, lookback: int = 60) -> list[Zone]:
    """
    Detect Order Blocks within the last ``lookback`` candles.

    Bullish OB : the last *bearish* (down) candle preceding a strong bullish
                 impulse. Bearish OB : the last *bullish* candle preceding a
                 strong bearish impulse.

    Returns the most recent zones first.
    """
    zones: list[Zone] = []
    n = len(df)
    if n < 5:
        return zones

    o = df["open"].values
    c = df["close"].values
    h = df["high"].values
    low = df["low"].values

    body = np.abs(c - o)
    avg_body = pd.Series(body).rolling(20, min_periods=1).mean().values

    start = max(1, n - lookback)
    for i in range(start, n - 1):
        impulse = body[i + 1]
        if impulse < config.IMPULSE_BODY_FACTOR * avg_body[i + 1]:
            continue
        # Bullish impulse candle -> preceding down candle is a bullish OB.
        if c[i + 1] > o[i + 1] and c[i] < o[i]:
            zones.append(Zone(low=low[i], high=h[i], direction="bullish", kind="OB", index=i))
        # Bearish impulse candle -> preceding up candle is a bearish OB.
        elif c[i + 1] < o[i + 1] and c[i] > o[i]:
            zones.append(Zone(low=low[i], high=h[i], direction="bearish", kind="OB", index=i))

    zones.sort(key=lambda z: z.index, reverse=True)
    return zones


# --------------------------------------------------------------------------- #
# Fair Value Gaps (3-candle imbalance)
# --------------------------------------------------------------------------- #
def find_fvgs(df: pd.DataFrame, lookback: int = 60) -> list[Zone]:
    """
    Detect Fair Value Gaps (3-candle imbalance).

    Bullish FVG : low[i+1] > high[i-1]  -> gap between candle i-1 high and
                  candle i+1 low. Bearish FVG : high[i+1] < low[i-1].

    Returns the most recent gaps first.
    """
    zones: list[Zone] = []
    n = len(df)
    if n < 3:
        return zones

    h = df["high"].values
    low = df["low"].values

    start = max(1, n - lookback)
    for i in range(start, n - 1):
        # Bullish FVG
        if low[i + 1] > h[i - 1]:
            zones.append(
                Zone(low=h[i - 1], high=low[i + 1], direction="bullish", kind="FVG", index=i)
            )
        # Bearish FVG
        elif h[i + 1] < low[i - 1]:
            zones.append(
                Zone(low=h[i + 1], high=low[i - 1], direction="bearish", kind="FVG", index=i)
            )

    zones.sort(key=lambda z: z.index, reverse=True)
    return zones


# --------------------------------------------------------------------------- #
# BOS / CHOCH
# --------------------------------------------------------------------------- #
@dataclass
class StructureBreak:
    type: str            # "BOS" | "CHOCH"
    direction: Direction
    index: int
    level: float


def detect_structure_break(df: pd.DataFrame, lookback: int = 40) -> Optional[StructureBreak]:
    """
    Detect the most recent Break of Structure / Change of Character.

    * BOS bullish  : close breaks above the most recent swing high.
    * BOS bearish  : close breaks below the most recent swing low.
    * CHOCH        : a BOS in the opposite direction of the prior structural
                     trend (first reversal signal).

    Returns the latest structure break (or ``None``).
    """
    sw = _swing_points(df)
    n = len(sw)
    if n < 6:
        return None

    close = sw["close"].values
    swing_high_idx = [i for i in range(n) if sw["swing_high"].iat[i]]
    swing_low_idx = [i for i in range(n) if sw["swing_low"].iat[i]]
    if not swing_high_idx or not swing_low_idx:
        return None

    # Determine prior trend from the sequence of the last two swing highs/lows.
    def _trend() -> Optional[Direction]:
        if len(swing_high_idx) >= 2 and len(swing_low_idx) >= 2:
            hh = sw["high"].iat[swing_high_idx[-1]] > sw["high"].iat[swing_high_idx[-2]]
            hl = sw["low"].iat[swing_low_idx[-1]] > sw["low"].iat[swing_low_idx[-2]]
            ll = sw["low"].iat[swing_low_idx[-1]] < sw["low"].iat[swing_low_idx[-2]]
            lh = sw["high"].iat[swing_high_idx[-1]] < sw["high"].iat[swing_high_idx[-2]]
            if hh and hl:
                return "bullish"
            if ll and lh:
                return "bearish"
        return None

    prior_trend = _trend()

    start = max(0, n - lookback)
    latest: Optional[StructureBreak] = None
    for i in range(start, n):
        # Last swing high / low strictly before i.
        prev_high = [j for j in swing_high_idx if j < i]
        prev_low = [j for j in swing_low_idx if j < i]
        if prev_high:
            level = sw["high"].iat[prev_high[-1]]
            if close[i] > level:
                kind = "CHOCH" if prior_trend == "bearish" else "BOS"
                latest = StructureBreak(kind, "bullish", i, level)
        if prev_low:
            level = sw["low"].iat[prev_low[-1]]
            if close[i] < level:
                kind = "CHOCH" if prior_trend == "bullish" else "BOS"
                latest = StructureBreak(kind, "bearish", i, level)
    return latest


# --------------------------------------------------------------------------- #
# Liquidity sweeps (equal highs / lows)
# --------------------------------------------------------------------------- #
def detect_liquidity_sweep(
    df: pd.DataFrame,
    tolerance: float = config.EQUAL_LEVEL_TOLERANCE,
    lookback: int = 30,
) -> Optional[Direction]:
    """
    Detect a liquidity sweep: equal highs / lows (within ``tolerance``) that get
    taken out by a wick, followed by a reversal close.

    * Sell-side sweep (bullish reaction) : equal lows swept then reclaimed ->
      ``"bullish"``.
    * Buy-side sweep (bearish reaction)  : equal highs swept then rejected ->
      ``"bearish"``.
    """
    n = len(df)
    if n < lookback + 2:
        return None

    recent = df.iloc[-lookback - 2 :]
    highs = recent["high"].values
    lows = recent["low"].values
    closes = recent["close"].values
    opens = recent["open"].values

    last_low, last_high, last_close, last_open = lows[-1], highs[-1], closes[-1], opens[-1]

    # Equal lows among the prior candles (exclude the last one).
    for i in range(len(lows) - 2):
        if abs(lows[i] - last_low) <= tolerance * last_low:
            # Wick swept below the equal low but closed back above -> bullish.
            if last_low < lows[i] and last_close > lows[i] and last_close > last_open:
                return "bullish"
    for i in range(len(highs) - 2):
        if abs(highs[i] - last_high) <= tolerance * last_high:
            if last_high > highs[i] and last_close < highs[i] and last_close < last_open:
                return "bearish"
    return None


# --------------------------------------------------------------------------- #
# RSI divergence
# --------------------------------------------------------------------------- #
def rsi_divergence(df: pd.DataFrame, lookback: int = 40) -> Optional[Direction]:
    """
    Detect a regular RSI divergence over the last ``lookback`` candles.

    * Bullish divergence : price makes a lower low while RSI makes a higher low.
    * Bearish divergence : price makes a higher high while RSI makes a lower high.
    """
    if len(df) < lookback + config.RSI_PERIOD:
        return None
    r = rsi(df["close"]).iloc[-lookback:]
    price = df["close"].iloc[-lookback:]
    if r.isna().all():
        return None

    # Split the window in two halves and compare the extremes.
    half = lookback // 2
    p1, p2 = price.iloc[:half], price.iloc[half:]
    r1, r2 = r.iloc[:half], r.iloc[half:]

    # Bullish: price lower low, RSI higher low.
    if p2.min() < p1.min() and r2.min() > r1.min():
        return "bullish"
    # Bearish: price higher high, RSI lower high.
    if p2.max() > p1.max() and r2.max() < r1.max():
        return "bearish"
    return None


# --------------------------------------------------------------------------- #
# Volatility classification
# --------------------------------------------------------------------------- #
def classify_volatility(df: pd.DataFrame) -> tuple[str, float]:
    """
    Classify volatility from ATR / price and return (label, atr_value).

    label in {"Low", "Medium", "High"}.
    """
    a = atr(df)
    atr_val = float(a.iloc[-1]) if not a.isna().all() else 0.0
    price = float(df["close"].iloc[-1])
    ratio = atr_val / price if price else 0.0
    if ratio < config.ATR_LOW_THRESHOLD:
        label = "Low"
    elif ratio > config.ATR_HIGH_THRESHOLD:
        label = "High"
    else:
        label = "Medium"
    return label, atr_val


# --------------------------------------------------------------------------- #
# Structural reference levels (for TP placement)
# --------------------------------------------------------------------------- #
def recent_swing_levels(df: pd.DataFrame, lookback: int = 60) -> tuple[list[float], list[float]]:
    """Return (swing_highs, swing_lows) prices within the lookback, newest last."""
    sw = _swing_points(df.iloc[-lookback:]) if len(df) > lookback else _swing_points(df)
    highs = sw.loc[sw["swing_high"], "high"].tolist()
    lows = sw.loc[sw["swing_low"], "low"].tolist()
    return highs, lows
