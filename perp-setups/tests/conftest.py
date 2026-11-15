"""Shared helpers for the tests: synthetic candles and a small configuration."""
from __future__ import annotations

import copy

import numpy as np
import pandas as pd
import pytest

from src import data, engine, setups

T0 = 1_600_000_200_000 // data.BAR_MS * data.BAR_MS  # arbitrary 15m-aligned epoch (ms)
T0 = T0 // (16 * data.BAR_MS) * (16 * data.BAR_MS)    # also aligned on 4h


def make_df(bars: list[tuple[float, float, float, float]], start_ms: int = T0, volume: float = 100.0) -> pd.DataFrame:
    """bars = [(open, high, low, close), ...] on consecutive 15m candles."""
    n = len(bars)
    arr = np.asarray(bars, dtype="float64")
    return pd.DataFrame({
        "open_time": start_ms + np.arange(n, dtype="int64") * data.BAR_MS,
        "open": arr[:, 0], "high": arr[:, 1], "low": arr[:, 2], "close": arr[:, 3],
        "volume": np.full(n, volume), "quote_volume": np.full(n, volume * 100.0),
    })


def flat(price: float, n: int) -> list[tuple[float, float, float, float]]:
    return [(price, price, price, price)] * n


def random_walk_df(n: int, seed: int, start_ms: int = T0, price: float = 100.0, vol: float = 0.004) -> pd.DataFrame:
    """Geometric random walk with realistic-looking wicks (for structural tests only, never for results)."""
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0, vol, n)
    regime = np.repeat(rng.normal(0.0, vol / 6.0, n // 200 + 1), 200)[:n]
    close = price * np.exp(np.cumsum(rets + regime))
    open_ = np.concatenate(([price], close[:-1]))
    wick = np.abs(rng.normal(0.0, vol / 2.0, (2, n)))
    high = np.maximum(open_, close) * (1.0 + wick[0])
    low = np.minimum(open_, close) * (1.0 - wick[1])
    volume = rng.uniform(50.0, 150.0, n) * (1.0 + 30.0 * np.abs(rets) / vol * (rng.random(n) > 0.8))
    return pd.DataFrame({
        "open_time": start_ms + np.arange(n, dtype="int64") * data.BAR_MS,
        "open": open_, "high": high, "low": low, "close": close,
        "volume": volume, "quote_volume": volume * close,
    })


def random_funding(n_bars: int, seed: int, start_ms: int = T0) -> pd.DataFrame:
    rng = np.random.default_rng(seed + 1000)
    times = np.arange(start_ms, start_ms + n_bars * data.BAR_MS, 8 * 3_600_000, dtype="int64")
    rates = rng.normal(0.0001, 0.0001, len(times))
    spikes = rng.random(len(times)) > 0.93
    rates[spikes] += rng.choice([-1.0, 1.0], spikes.sum()) * 0.0012
    return pd.DataFrame({"funding_time": times + 3, "funding_rate": rates})


def make_symbol(df: pd.DataFrame, cfg: dict, funding: pd.DataFrame | None = None, symbol: str = "TESTUSDT",
                warmup_ms: int = 0):
    ctx = setups.SymbolContext(symbol, df, funding, cfg, warmup_ms=warmup_ms)
    sd = engine.SymbolData(symbol, df, funding)
    for tf in ("15m", "1h", "4h"):
        b = ctx.bars[tf]
        sd.add_tf(tf, b.ot, b.h, b.l, b.atr)
    return ctx, sd


def signal(order_time: int, direction: int, **kw) -> dict:
    base = {"symbol": "TESTUSDT", "order_time": order_time, "direction": direction, "order_type": "market",
            "limit_price": np.nan, "stop_price": np.nan, "stop_dist": np.nan, "tp_r": np.nan, "tp_price": np.nan,
            "trail_mult": np.nan, "max_hold_ms": np.nan, "expiry_ms": np.nan, "atr": 1.0, "tf": "15m"}
    base.update(kw)
    return base


def signals_df(rows: list[dict]) -> pd.DataFrame:
    return pd.DataFrame(rows)[engine.SIGNAL_COLUMNS]


@pytest.fixture()
def cfg() -> dict:
    return copy.deepcopy(data.load_config())


@pytest.fixture()
def cfg_nocost(cfg) -> dict:
    cfg["costs"].update(maker_fee=0.0, taker_fee=0.0, slippage=0.0)
    return cfg
