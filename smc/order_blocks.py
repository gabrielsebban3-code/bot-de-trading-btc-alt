"""
Order Block detection.

Bullish OB  = the last bearish candle (close < open) immediately before a
              strong bullish impulse (next candle closes above the OB high).
Bearish OB  = the last bullish candle (close > open) immediately before a
              strong bearish impulse (next candle closes below the OB low).
"""

from dataclasses import dataclass
import pandas as pd
from config import OB_LOOKBACK


@dataclass
class OrderBlock:
    direction: str   # 'bullish' or 'bearish'
    high: float
    low: float
    index: int       # candle index in the df


def find_order_blocks(df: pd.DataFrame, lookback: int = OB_LOOKBACK) -> list[OrderBlock]:
    blocks: list[OrderBlock] = []
    window = df.iloc[-(lookback + 2):-1]  # exclude unclosed candle

    for i in range(len(window) - 1):
        candle  = window.iloc[i]
        nxt     = window.iloc[i + 1]

        # Bullish OB: bearish candle followed by strong bullish close above OB high
        if candle["close"] < candle["open"] and nxt["close"] > candle["high"]:
            blocks.append(OrderBlock("bullish", candle["high"], candle["low"], i))

        # Bearish OB: bullish candle followed by strong bearish close below OB low
        if candle["close"] > candle["open"] and nxt["close"] < candle["low"]:
            blocks.append(OrderBlock("bearish", candle["high"], candle["low"], i))

    return blocks


def price_in_ob(price: float, ob: OrderBlock) -> bool:
    return ob.low <= price <= ob.high


def nearest_touched_ob(price: float, blocks: list[OrderBlock], direction: str) -> OrderBlock | None:
    """
    Returns the most recent OB of the given direction whose zone price currently touches.
    """
    candidates = [b for b in reversed(blocks)
                  if b.direction == direction and price_in_ob(price, b)]
    return candidates[0] if candidates else None
