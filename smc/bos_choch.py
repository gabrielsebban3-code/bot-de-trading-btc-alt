"""
BOS (Break of Structure) and CHOCH (Change of Character) detection.

BOS bullish  = current close breaks above the most recent swing high.
BOS bearish  = current close breaks below the most recent swing low.
CHOCH        = BOS in the opposite direction of the prevailing trend.
"""

import pandas as pd


def _swing_highs_lows(df: pd.DataFrame, n: int = 3):
    """Identify swing highs and lows using n-candle lookback on each side."""
    highs, lows = [], []
    for i in range(n, len(df) - n):
        if df["high"].iloc[i] == df["high"].iloc[i - n:i + n + 1].max():
            highs.append(i)
        if df["low"].iloc[i] == df["low"].iloc[i - n:i + n + 1].min():
            lows.append(i)
    return highs, lows


def detect_bos(df: pd.DataFrame) -> dict:
    """
    Looks at the last closed candle and returns:
      {
        'bullish_bos': bool,
        'bearish_bos': bool,
        'swing_high': float | None,
        'swing_low':  float | None,
      }
    """
    window = df.iloc[-60:-1]
    high_idxs, low_idxs = _swing_highs_lows(window)

    last_close = window["close"].iloc[-1]

    swing_high = window["high"].iloc[high_idxs[-1]] if high_idxs else None
    swing_low  = window["low"].iloc[low_idxs[-1]]   if low_idxs  else None

    bullish_bos = swing_high is not None and last_close > swing_high
    bearish_bos = swing_low  is not None and last_close < swing_low

    return {
        "bullish_bos": bullish_bos,
        "bearish_bos": bearish_bos,
        "swing_high":  swing_high,
        "swing_low":   swing_low,
    }


def detect_choch(df: pd.DataFrame) -> dict:
    """
    CHOCH is detected when:
    - The trend was bearish (series of lower lows) but we get a bullish BOS  → bullish CHOCH
    - The trend was bullish (series of higher highs) but we get a bearish BOS → bearish CHOCH
    """
    bos = detect_bos(df)
    window = df.iloc[-60:-1]
    high_idxs, low_idxs = _swing_highs_lows(window)

    bullish_choch = bearish_choch = False

    if len(low_idxs) >= 2:
        prev_low = window["low"].iloc[low_idxs[-2]]
        last_low = window["low"].iloc[low_idxs[-1]]
        if last_low < prev_low and bos["bullish_bos"]:
            bullish_choch = True

    if len(high_idxs) >= 2:
        prev_high = window["high"].iloc[high_idxs[-2]]
        last_high = window["high"].iloc[high_idxs[-1]]
        if last_high > prev_high and bos["bearish_bos"]:
            bearish_choch = True

    return {**bos, "bullish_choch": bullish_choch, "bearish_choch": bearish_choch}
