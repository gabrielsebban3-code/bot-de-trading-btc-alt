"""
Fair Value Gap detection.

A FVG is a 3-candle imbalance:
  Bullish FVG: candle[i+2].low > candle[i].high  (gap between candle i and i+2)
  Bearish FVG: candle[i+2].high < candle[i].low
"""

from dataclasses import dataclass
import pandas as pd
from config import FVG_MIN_GAP_PCT, OB_LOOKBACK


@dataclass
class FVG:
    direction: str   # 'bullish' or 'bearish'
    top: float
    bottom: float
    index: int


def find_fvgs(df: pd.DataFrame, lookback: int = OB_LOOKBACK) -> list[FVG]:
    fvgs: list[FVG] = []
    window = df.iloc[-(lookback + 3):-1]

    for i in range(len(window) - 2):
        c0, c2 = window.iloc[i], window.iloc[i + 2]
        mid_price = (c0["close"] + c2["close"]) / 2

        # Bullish FVG
        if c2["low"] > c0["high"]:
            gap = c2["low"] - c0["high"]
            if gap / mid_price >= FVG_MIN_GAP_PCT:
                fvgs.append(FVG("bullish", c2["low"], c0["high"], i))

        # Bearish FVG
        if c2["high"] < c0["low"]:
            gap = c0["low"] - c2["high"]
            if gap / mid_price >= FVG_MIN_GAP_PCT:
                fvgs.append(FVG("bearish", c0["low"], c2["high"], i))

    return fvgs


def price_in_fvg(price: float, fvg: FVG) -> bool:
    return fvg.bottom <= price <= fvg.top


def nearest_touched_fvg(price: float, fvgs: list[FVG], direction: str) -> FVG | None:
    candidates = [f for f in reversed(fvgs)
                  if f.direction == direction and price_in_fvg(price, f)]
    return candidates[0] if candidates else None
