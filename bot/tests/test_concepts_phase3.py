"""C3 / C4 / C5: no-lookahead on the signals themselves, plus hand-checked helpers."""
import numpy as np
import pandas as pd
import pytest

from bot.concepts import c3_mean_reversion as c3
from bot.concepts import c4_funding_oi as c4
from bot.concepts import c5_smc_reversal as c5
from bot.concepts.base import SymbolData
from bot.tests.conftest import M15, T0, make_bars

H = 4 * M15


def _sd(cfg, close, vol, n_days):
    sd = SymbolData("TESTUSDT", make_bars(close, spread=0.002, volume=vol), cfg)
    rng = np.random.default_rng(11)
    ft = T0 + np.arange(n_days * 3) * 8 * H
    sd.funding = pd.DataFrame({"time": ft, "rate": rng.normal(0.0001, 0.0002, len(ft))})
    sd.xs_funding = pd.DataFrame({"time": ft, "median": np.full(len(ft), 0.0001)})
    ot = T0 + np.arange(n_days * 24) * H + 55 * 60_000
    oi = 1e6 * np.exp(np.cumsum(rng.normal(0, 0.03, len(ot))))
    sd.oi = pd.DataFrame({"time": ot, "oi": oi, "oi_value": oi})
    return sd


def _gen(module, cfg, params, close, vol, n_days):
    return module.generate_signals({"TESTUSDT": _sd(cfg, close, vol, n_days)}, cfg, params)


def _keys(sigs):
    return sorted((s.generated_at, int(s.direction), round(s.stop, 10), round(s.entry, 10), s.variant) for s in sigs)


@pytest.fixture
def pcfg(cfg):
    cfg["engine"]["warmup_days"] = 5
    return cfg


@pytest.mark.parametrize("module,params", [
    (c3, {"tf": "1h", "rsi_period": 2, "deviation": "bb"}),
    (c3, {"tf": "1h", "rsi_period": 3, "deviation": "vwap"}),
    (c4, {"signal": "funding_abs", "window_days": 7, "z": 2}),
    (c4, {"signal": "funding_rel", "window_days": 7, "z": 2}),
    (c4, {"signal": "oi_purge", "oi_drop": 0.10}),
    (c5, {"tf": "1h", "liquidity": "equal", "zone": "fvg", "tp_r": 2, "min_score": 0}),
    (c5, {"tf": "1h", "liquidity": "period", "zone": "ob", "tp_r": 3, "min_score": 0}),
])
def test_phase3_signals_do_not_depend_on_future(pcfg, module, params):
    rng = np.random.default_rng(5)
    n_days = 260
    n = n_days * 96
    close = 100 * np.exp(np.cumsum(rng.normal(0.00003, 0.005, n)))
    vol = rng.lognormal(4, 0.7, n)
    full = _gen(module, pcfg, params, close, vol, n_days)
    assert len(full) >= 2, "vacuous test"
    for cut_day in (170, 221):
        cut = cut_day * 96
        cut_ms = T0 + cut * M15
        part = module.generate_signals({"TESTUSDT": _sd_cut(pcfg, close, vol, n_days, cut)}, pcfg, params)
        assert _keys([s for s in full if s.generated_at <= cut_ms]) == _keys(part)


def _sd_cut(cfg, close, vol, n_days, cut):
    sd = _sd(cfg, close[:cut], vol[:cut], n_days)
    lim = T0 + cut * M15
    sd.funding = sd.funding[sd.funding["time"] < lim]
    sd.xs_funding = sd.xs_funding[sd.xs_funding["time"] < lim]
    sd.oi = sd.oi[sd.oi["time"] < lim]
    return sd


def test_time_zscore_by_hand():
    t = np.array([0, 10, 20, 30, 40, 50], dtype="int64")
    x = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 100.0])
    z = c4.time_zscore(t, x, window_ms=45, min_obs=3)
    prev = x[1:5]                                      # times 10..40 are within [50 - 45, 50)
    assert z[5] == pytest.approx((100 - prev.mean()) / prev.std(ddof=1))
    assert np.isnan(z[2])                              # only 2 previous observations


def test_crowded_filter_drops_longs_when_funding_is_extreme(pcfg):
    from bot.core.types import Direction, ExitKind, ExitRule, Signal
    rng = np.random.default_rng(1)
    sd = _sd(pcfg, 100 * np.exp(np.cumsum(rng.normal(0, 0.003, 60 * 96))), None, 60)
    rates = np.full(len(sd.funding), 0.0001)
    rates[-1] = 0.01                                   # extreme positive funding at the last settlement
    rates[:-1] += rng.normal(0, 1e-5, len(rates) - 1)
    sd.funding = sd.funding.assign(rate=rates)
    t = int(sd.funding["time"].iloc[-1]) + H
    mk = lambda d: Signal(symbol="TESTUSDT", direction=Direction(d), concept="C1", variant="v", tf_signal="1h",
                          tf_context=None, generated_at=t, entry=100.0, order_type="market", stop=99.0,
                          exit_rule=ExitRule(ExitKind.TAKE_PROFIT, tp_r=2, tf="1h"))
    kept = c4.crowded_filter([mk(1), mk(-1)], {"TESTUSDT": sd}, 30, 2.0)
    assert [int(s.direction) for s in kept] == [-1]
