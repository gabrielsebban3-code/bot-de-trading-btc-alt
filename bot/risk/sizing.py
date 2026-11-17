"""Position sizing (Step 8): constant risk in % of the simulated capital, volatility-based through the stop.

No martingale, no averaging down: the size depends only on capital, risk and the stop distance.
"""
from __future__ import annotations


def position_size(capital: float, risk_per_trade: float, r_dist: float, entry_price: float,
                  max_leverage: float) -> tuple[float, bool]:
    """(size in coins, True if the leverage cap reduced it)."""
    if capital <= 0 or r_dist <= 0 or entry_price <= 0:
        return 0.0, False
    size = capital * risk_per_trade / r_dist
    cap = max_leverage * capital / entry_price
    if size > cap:
        return cap, True
    return size, False
