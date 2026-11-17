"""Weight of trading costs per timeframe (Step 5), measured before any strategy.

For a stop placed at ``stop_atr`` x ATR(14) of the timeframe, the round-trip cost (taker fee twice plus
slippage twice, slippage from the configured model at a typical notional) is expressed in R:

    cost_R = (2 * taker + 2 * slippage) / (stop_atr * ATR / price)

A strategy on that timeframe must earn more than ``cost_R`` per trade BEFORE costs just to break even.
No signal is involved: only volatility and the cost model.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS
from ..data.resampler import resample
from ..data.storage import MarketStore
from ..indicators.volatility import atr


def cost_share(store: MarketStore, cfg: dict, symbol: str, base_tf: str, tfs: list[str], start_ms: int, end_ms: int,
               stop_atr: float = 2.0, notional: float = 5000.0) -> pd.DataFrame:
    base = store.candles(symbol, base_tf, start_ms, end_ms)
    if base.empty:
        return pd.DataFrame()
    c = cfg["costs"]
    sp = c["slippage"]
    daily = resample(base, base_tf, "1d")
    adv = float(daily["quote_volume"].median())
    dvol = float(np.nanstd(np.diff(np.log(daily["close"].to_numpy())), ddof=1))
    a15 = resample(base, base_tf, "15m") if base_tf == "1m" else base
    atr15 = atr(a15["high"], a15["low"], a15["close"], int(sp["atr_period"])) / a15["close"].to_numpy()
    slip = sp["base"] + sp["atr_coef"] * float(np.nanmedian(atr15)) + sp["impact_coef"] * dvol * np.sqrt(notional / adv)
    rows = []
    for tf in tfs:
        b = resample(base, base_tf, tf)
        frac = atr(b["high"], b["low"], b["close"], 14) / b["close"].to_numpy()
        med = float(np.nanmedian(frac))
        rt = 2 * c["taker_fee"] + 2 * slip
        rows.append({"symbol": symbol, "tf": tf, "median_atr_pct": 100 * med, "slippage_pct": 100 * slip,
                     "roundtrip_cost_pct": 100 * rt, "cost_R": rt / (stop_atr * med)})
    return pd.DataFrame(rows)
