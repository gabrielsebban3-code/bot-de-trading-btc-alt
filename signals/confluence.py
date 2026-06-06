"""
Per-timeframe bias evaluation.
Returns 'bullish', 'bearish', or 'neutral' for a given prepared DataFrame.
"""

import pandas as pd
from indicators.ema import add_emas, ema_bias
from indicators.rsi import add_rsi, rsi_bias
from smc.bos_choch import detect_choch
from smc.liquidity import detect_liquidity_sweep


def timeframe_bias(df: pd.DataFrame) -> str:
    df = add_emas(add_rsi(df))

    eb = ema_bias(df)
    rb = rsi_bias(df)
    bos = detect_choch(df)
    liq = detect_liquidity_sweep(df)

    bull_score = bear_score = 0

    if eb == "bullish":
        bull_score += 1
    elif eb == "bearish":
        bear_score += 1

    if rb == "bullish":
        bull_score += 1
    elif rb == "bearish":
        bear_score += 1

    if bos["bullish_bos"] or bos["bullish_choch"]:
        bull_score += 1
    if bos["bearish_bos"] or bos["bearish_choch"]:
        bear_score += 1

    if liq["bullish_sweep"]:
        bull_score += 1
    if liq["bearish_sweep"]:
        bear_score += 1

    if bull_score > bear_score and bull_score >= 2:
        return "bullish"
    if bear_score > bull_score and bear_score >= 2:
        return "bearish"
    return "neutral"


def count_aligned_timeframes(biases: dict[str, str], direction: str) -> int:
    return sum(1 for b in biases.values() if b == direction)
