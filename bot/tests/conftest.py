"""Shared fixtures: synthetic candles with known structure, temporary stores, test configuration."""
from __future__ import annotations

import copy

import numpy as np
import pandas as pd
import pytest

from bot.core.config import load_config

T0 = 1_577_836_800_000  # 2020-01-01 00:00 UTC
M15 = 15 * 60_000


def make_bars(close, tf_ms: int = M15, t0: int = T0, spread: float = 0.002, volume=None) -> pd.DataFrame:
    """Candles from a close path: open = previous close, high/low = max/min(open, close) +/- spread."""
    c = np.asarray(close, dtype="float64")
    o = np.concatenate(([c[0]], c[:-1]))
    h = np.maximum(o, c) * (1 + spread)
    l = np.minimum(o, c) * (1 - spread)
    v = np.full(len(c), 100.0) if volume is None else np.asarray(volume, dtype="float64")
    return pd.DataFrame({"open_time": t0 + np.arange(len(c), dtype="int64") * tf_ms, "open": o, "high": h,
                         "low": l, "close": c, "volume": v, "quote_volume": v * c,
                         "trades": np.full(len(c), 10), "taker_buy_quote": v * c / 2})


def random_walk(n: int, seed: int = 0, start: float = 100.0, vol: float = 0.01) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return start * np.exp(np.cumsum(rng.normal(0, vol, n)))


@pytest.fixture
def cfg(tmp_path):
    c = copy.deepcopy(load_config())
    c["paths"]["market_db"] = str(tmp_path / "m.sqlite")
    c["paths"]["state_db"] = str(tmp_path / "s.sqlite")
    return c
