"""C1 / C2 signals: correctness on known paths and the mandatory no-lookahead test on the signals themselves."""
import numpy as np
import pandas as pd
import pytest

from bot.concepts import c1_trend_breakout as c1
from bot.concepts import c2_trend_pullback as c2
from bot.concepts.base import SymbolData
from bot.tests.conftest import M15, T0, make_bars


def trending_path(days: int, seed: int, drift: float, vol: float = 0.004) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = days * 96
    steps = rng.normal(drift, vol, n)
    # alternate impulse and pullback phases so that both breakouts and pullbacks exist
    phase = np.sin(np.arange(n) / 400.0)
    return 100 * np.exp(np.cumsum(steps + 0.002 * phase * vol / 0.004 * 0.1))


def sdata(cfg, close, sym="TESTUSDT", volume=None):
    return {sym: SymbolData(sym, make_bars(close, spread=0.001, volume=volume), cfg)}


def _keys(sigs):
    return sorted((s.symbol, s.generated_at, int(s.direction), round(s.stop, 10), s.variant) for s in sigs)


@pytest.fixture
def ccfg(cfg):
    cfg["engine"]["warmup_days"] = 5
    return cfg


def test_c1_uptrend_gives_only_longs_beyond_the_channel(ccfg):
    close = trending_path(150, seed=1, drift=0.00015)
    data = sdata(ccfg, close)
    sigs = c1.generate_signals(data, ccfg, {"tf": "1h", "entry_n": "20", "trail": "chandelier", "direction": "both"})
    assert len(sigs) > 0
    assert all(int(s.direction) == 1 for s in sigs)
    b = data["TESTUSDT"].bars["1h"]
    hi, _ = b.donchian(20)
    for s in sigs:
        t = int(np.searchsorted(b.ct, s.generated_at))
        assert b.ct[t] == s.generated_at and b.c[t] > hi[t]
        assert s.stop_offset == pytest.approx(2.5 * b.atr(14)[t])


def test_c1_short_only_mode_in_uptrend_is_empty(ccfg):
    close = trending_path(150, seed=1, drift=0.00015)
    sigs = c1.generate_signals(sdata(ccfg, close), ccfg, {"tf": "1h", "entry_n": "55", "trail": "donchian",
                                                          "direction": "short"})
    assert sigs == []


@pytest.mark.parametrize("module,params", [
    (c1, {"tf": "1h", "entry_n": "20", "trail": "chandelier", "direction": "both"}),
    (c1, {"tf": "1h", "entry_n": "ensemble", "trail": "donchian", "direction": "both", "volume_filter": True}),
    (c2, {"tf": "1h", "pullback": "ema20", "pivots": "fractal", "direction": "both"}),
    (c2, {"tf": "1h", "pullback": "structure", "pivots": "zigzag", "direction": "both"}),
    (c2, {"tf": "4h", "pullback": "ema20", "pivots": "hierarchical", "direction": "both"}),
])
def test_signals_do_not_depend_on_future_candles(ccfg, module, params):
    rng = np.random.default_rng(7)
    n = 300 * 96
    close = 100 * np.exp(np.cumsum(rng.normal(0.00005, 0.004, n)))
    vol = rng.lognormal(4, 0.6, n)
    full = module.generate_signals(sdata(ccfg, close, volume=vol), ccfg, params)
    assert len(full) >= 2, "the test would be vacuous without signals"
    for cut_day in (200, 263):
        cut = cut_day * 96
        part = module.generate_signals(sdata(ccfg, close[:cut], volume=vol[:cut]), ccfg, params)
        cut_ms = T0 + cut * M15
        assert _keys([s for s in full if s.generated_at <= cut_ms]) == _keys(part)
        # perturbing the future changes nothing before the cut
        alt = np.concatenate([close[:cut], close[cut - 1] * np.exp(np.cumsum(rng.normal(0, 0.02, len(close) - cut)))])
        alt_sigs = module.generate_signals(sdata(ccfg, alt, volume=vol), ccfg, params)
        assert _keys([s for s in alt_sigs if s.generated_at <= cut_ms]) == _keys(part)


def test_c2_signal_after_pullback_and_on_trigger_close(ccfg):
    rng = np.random.default_rng(3)
    close = 100 * np.exp(np.cumsum(rng.normal(0.0001, 0.004, 160 * 96)))
    data = sdata(ccfg, close)
    sigs = c2.generate_signals(data, ccfg, {"tf": "1h", "pullback": "ema20", "pivots": "fractal", "direction": "both"})
    assert len(sigs) > 0
    t15 = data["TESTUSDT"].bars["15m"]
    for s in sigs:
        assert s.generated_at in set(t15.ct)                    # decided on a CLOSED trigger candle
        assert (s.entry - s.stop) * int(s.direction) > 0        # stop on the right side
