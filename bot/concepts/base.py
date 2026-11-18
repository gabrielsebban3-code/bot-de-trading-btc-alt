"""Common concept interface (Step 2): ``generate_signals(data, cfg, params) -> list[Signal]``.

``SymbolData`` holds the closed candles of one symbol on every timeframe (resampled from 15m, complete
candles only) with lazily computed, cached indicators. Every array at index i uses candles 0..i only.
"""
from __future__ import annotations

from typing import Callable

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS, tf_ms
from ..data.resampler import resample
from ..indicators._core import rolling_incl, rolling_prev
from ..indicators.trend import adx, donchian, ema
from ..indicators.volatility import atr
from ..structure.market_structure import structure_events
from ..structure.pivots import detect

TFS = ("15m", "1h", "4h", "1d")


class Bars:
    def __init__(self, df: pd.DataFrame, tf: str):
        self.tf = tf
        self.step = tf_ms(tf)
        self.df = df
        self.ot = df["open_time"].to_numpy(dtype="int64")
        self.ct = df["close_time"].to_numpy(dtype="int64")
        self.o = df["open"].to_numpy(dtype="float64")
        self.h = df["high"].to_numpy(dtype="float64")
        self.l = df["low"].to_numpy(dtype="float64")
        self.c = df["close"].to_numpy(dtype="float64")
        self.v = df["volume"].to_numpy(dtype="float64")
        self.contig = df["contig"].to_numpy(dtype=bool)
        self.n = len(self.ot)
        self._cache: dict = {}

    def cached(self, key, fn: Callable):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]

    def ema(self, p: int) -> np.ndarray:
        return self.cached(("ema", p), lambda: ema(self.c, p))

    def atr(self, p: int = 14) -> np.ndarray:
        return self.cached(("atr", p), lambda: atr(self.h, self.l, self.c, p))

    def adx(self, p: int = 14) -> np.ndarray:
        return self.cached(("adx", p), lambda: adx(self.h, self.l, self.c, p))

    def donchian(self, n: int) -> tuple[np.ndarray, np.ndarray]:
        return self.cached(("dc", n), lambda: donchian(self.h, self.l, n))

    def vol_mean_prev(self, n: int) -> np.ndarray:
        return self.cached(("vmean", n), lambda: rolling_prev(self.v, n, "mean"))

    def pivots(self, method: str, cfg_structure: dict) -> pd.DataFrame:
        key = ("piv", method, repr(sorted((k, repr(v)) for k, v in cfg_structure.items())))
        return self.cached(key, lambda: detect(method, self.h, self.l, self.atr(14), cfg_structure))

    def events(self, method: str, cfg_structure: dict, level: str | None) -> pd.DataFrame:
        def _build():
            piv = self.pivots(method, cfg_structure)
            if level is not None and method == "hierarchical":
                piv = piv[piv["level"] == level]
            ev, _ = structure_events(self.c, piv)
            return ev
        key = ("ev", method, level, repr(sorted((k, repr(v)) for k, v in cfg_structure.items())))
        return self.cached(key, _build)

    def valid(self, warmup_days: int, min_volume: float = 0.0) -> np.ndarray:
        """Candles at least ``warmup_days`` after the start of history / the last gap, with volume."""
        def _build():
            if self.n == 0:
                return np.zeros(0, dtype=bool)
            brk = np.where(~self.contig, self.ot, np.int64(-1))
            brk[0] = self.ot[0]
            ok = (self.ot - np.maximum.accumulate(brk)) >= warmup_days * DAY_MS
            return ok & (self.v > min_volume)
        return self.cached(("valid", warmup_days, min_volume), _build)


class SymbolData:
    """All timeframes of one symbol, built from 15m candles."""

    def __init__(self, symbol: str, df15: pd.DataFrame, cfg: dict, tfs: tuple[str, ...] = TFS):
        self.symbol = symbol
        self.cfg = cfg
        self.bars = {tf: Bars(resample(df15, "15m", tf), tf) for tf in tfs}
        self._cache: dict = {}

    def cached(self, key, fn: Callable):
        if key not in self._cache:
            self._cache[key] = fn()
        return self._cache[key]


def merged_params(cfg: dict, concept_key: str, params: dict) -> dict:
    """Defaults of config.yaml (concept + regime + common) overridden by the variant's parameters."""
    p = {}
    p.update(cfg["concepts"]["common"])
    p.update(cfg["concepts"]["regime"])
    p.update(cfg["concepts"][concept_key])
    p.update(params)
    return p


def direction_allowed(direction_mode: str, d: int) -> bool:
    return direction_mode == "both" or (direction_mode == "long" and d > 0) or (direction_mode == "short" and d < 0)


def variant_id(concept: str, params: dict) -> str:
    keys = sorted(k for k in params if k not in ("concept",))
    return concept + "_" + "_".join(f"{k}-{params[k]}" for k in keys)
