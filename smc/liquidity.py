"""
Liquidity sweep detection.

Equal highs / equal lows (within tolerance) that are subsequently swept by a
wick, followed by a strong reversal close.
"""

import pandas as pd
from config import LIQUIDITY_TOLERANCE


def detect_liquidity_sweep(df: pd.DataFrame) -> dict:
    """
    Returns {'bullish_sweep': bool, 'bearish_sweep': bool}.

    Bullish sweep: price wicked below equal lows then closed back above them.
    Bearish sweep: price wicked above equal highs then closed back below them.
    """
    window = df.iloc[-30:-1]
    last   = window.iloc[-1]

    bullish_sweep = False
    bearish_sweep = False

    # Collect equal lows (potential buy-side liquidity below)
    lows = window["low"].values[:-1]
    for lvl in lows:
        equal_lows = [l for l in lows if abs(l - lvl) / lvl <= LIQUIDITY_TOLERANCE]
        if len(equal_lows) >= 2:
            ref = min(equal_lows)
            if last["low"] < ref and last["close"] > ref:
                bullish_sweep = True
                break

    # Collect equal highs (potential sell-side liquidity above)
    highs = window["high"].values[:-1]
    for lvl in highs:
        equal_highs = [h for h in highs if abs(h - lvl) / lvl <= LIQUIDITY_TOLERANCE]
        if len(equal_highs) >= 2:
            ref = max(equal_highs)
            if last["high"] > ref and last["close"] < ref:
                bearish_sweep = True
                break

    return {"bullish_sweep": bullish_sweep, "bearish_sweep": bearish_sweep}
