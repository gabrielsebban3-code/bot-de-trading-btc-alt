"""
SL and TP calculation based on SMC levels.
"""

from dataclasses import dataclass
from config import SL_BUFFER_PCT, TP1_RR, TP2_RR, TP3_RR
from smc.order_blocks import OrderBlock
from smc.fvg import FVG


@dataclass
class Levels:
    entry_low: float
    entry_high: float
    sl: float
    tp1: float
    tp2: float
    tp3: float


def _rr_target(entry: float, sl: float, rr: float, direction: str) -> float:
    risk = abs(entry - sl)
    if direction == "long":
        return entry + risk * rr
    return entry - risk * rr


def compute_levels(
    direction: str,
    price: float,
    ob: OrderBlock | None,
    fvg: FVG | None,
) -> Levels:
    """
    direction: 'long' or 'short'
    Uses the triggered OB or FVG zone for entry range and SL reference.
    Falls back to a 0.5% range around price if neither is available.
    """
    if ob:
        zone_low  = ob.low
        zone_high = ob.high
    elif fvg:
        zone_low  = fvg.bottom
        zone_high = fvg.top
    else:
        zone_low  = price * (1 - 0.005)
        zone_high = price * (1 + 0.005)

    if direction == "long":
        sl = zone_low * (1 - SL_BUFFER_PCT)
        entry = (zone_low + zone_high) / 2
    else:
        sl = zone_high * (1 + SL_BUFFER_PCT)
        entry = (zone_low + zone_high) / 2

    tp1 = _rr_target(entry, sl, TP1_RR, direction)
    tp2 = _rr_target(entry, sl, TP2_RR, direction)
    tp3 = _rr_target(entry, sl, TP3_RR, direction)

    return Levels(
        entry_low=zone_low,
        entry_high=zone_high,
        sl=sl,
        tp1=tp1,
        tp2=tp2,
        tp3=tp3,
    )
