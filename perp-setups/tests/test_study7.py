"""Study 7: daily portfolio strategies never use a value that is not known at the decision."""
import numpy as np
import pandas as pd
import pytest

from src import etude7

FX = {"TSMOM": {"vol_window": 60, "target_vol_per_asset": 0.10, "max_gross_leverage": 2.0},
      "XSMOM": {"gross_leverage": 1.0}, "CARRY": {"perp_margin_share": 0.25}}
COSTS = {"perp_fee": 0.0005, "spot_fee": 0.001, "slippage": 0.0002}


@pytest.fixture(scope="module")
def market():
    rng = np.random.default_rng(3)
    idx = pd.date_range("2021-01-01", periods=700, freq="D", tz="UTC")
    syms = [f"S{i}" for i in range(8)]
    close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0.0005, 0.04, (700, 8)), axis=0)), idx, syms)
    close.iloc[:200, 7] = np.nan                                          # a late listing
    spot = close * (1 + rng.normal(0, 0.001, close.shape))
    fund = pd.DataFrame(rng.normal(0.0002, 0.0004, close.shape), idx, syms)
    return close, spot, fund


@pytest.mark.parametrize("fam,p", [("TSMOM", {"lookback": 60, "side": "long_short"}), ("TSMOM", {"lookback": 20, "side": "long_only"}),
                                   ("XSMOM", {"lookback": 28, "n_each_side": 3}), ("CARRY", {"window_days": 3, "min_annual_funding": 0.1})])
def test_decisions_do_not_use_future_rows(market, fam, p):
    close, spot, fund = market
    def decide(c, s, f):
        av = etude7.available(c, 130)
        if fam == "TSMOM":
            return etude7.w_tsmom(c, av, p, FX[fam])
        if fam == "XSMOM":
            return etude7.w_xsmom(c, av, p, FX[fam])
        return etude7.carry_active(s, f, av, p).astype(float)
    full = decide(close, spot, fund)
    for cut in (400, 555):
        part = decide(close.iloc[:cut], spot.iloc[:cut], fund.iloc[:cut])
        pd.testing.assert_frame_equal(part, full.iloc[:cut], check_freq=False)
    assert full.abs().sum().sum() > 0


def test_weights_change_only_on_mondays_and_respect_the_cap(market):
    close, _, _ = market
    w = etude7.w_tsmom(close, etude7.available(close, 130), {"lookback": 20, "side": "long_short"}, FX["TSMOM"])
    changed = (w.diff().abs().sum(axis=1) > 0)
    assert set(w.index[changed].day_of_week) <= {6}                        # decided on Sunday close
    assert (w.abs().sum(axis=1) <= 2.0 + 1e-12).all() and (w.iloc[:130] == 0).all().all()
    x = etude7.w_xsmom(close, etude7.available(close, 130), {"lookback": 7, "n_each_side": 3}, FX["XSMOM"])
    live = x[x.abs().sum(axis=1) > 0]
    assert np.allclose(live.sum(axis=1), 0) and np.allclose(live.abs().sum(axis=1), 1.0)


def test_directional_pnl_timing_funding_and_costs():
    idx = pd.date_range("2022-01-02", periods=4, freq="D", tz="UTC")          # a Sunday first
    close = pd.DataFrame({"A": [100.0, 110.0, 99.0, 99.0]}, idx)
    fund = pd.DataFrame({"A": [0.0, 0.001, 0.0, 0.0]}, idx)
    w = pd.DataFrame({"A": [0.5, 0.5, 0.5, 0.5]}, idx)
    ret, held, trades = etude7.run_directional(w, close, fund, COSTS)
    cost = 0.5 * (0.0005 + 0.0002)
    assert ret.iloc[0] == 0.0                                               # nothing held on the decision day
    assert ret.iloc[1] == pytest.approx(0.5 * 0.10 - 0.5 * 0.001 - cost)     # long pays funding, cost of entry
    assert ret.iloc[2] == pytest.approx(0.5 * -0.10) and trades == 1


def test_carry_pnl_is_spot_minus_perp_plus_funding():
    idx = pd.date_range("2022-01-01", periods=3, freq="D", tz="UTC")
    close = pd.DataFrame({"A": [100.0, 120.0, 120.0]}, idx)
    spot = pd.DataFrame({"A": [100.0, 119.0, 120.0]}, idx)
    fund = pd.DataFrame({"A": [0.0, 0.002, 0.0]}, idx)
    act = pd.DataFrame({"A": [True, True, True]}, idx)
    ret, held, _ = etude7.run_carry(act, close, spot, fund, act, FX["CARRY"], COSTS)
    n = 1 / 1.25
    assert ret.iloc[1] == pytest.approx(n * (0.19 - 0.20 + 0.002) - n * (0.0005 + 0.001 + 0.0004))
