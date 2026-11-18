"""Formulas checked against published reference values (independent sources, not our own numbers).

* Deflated Sharpe Ratio: worked example of Bailey & López de Prado (2014): annualised SR 2.5 on 1 250 daily
  returns, 100 trials whose Sharpe ratios have an annual variance of 0.5, skewness -3, kurtosis 10
  -> SR0 = 0.1132 per day, DSR = 0.9004 (also reproduced by independent implementations).
* Isolated-margin liquidation price, maintenance margin on the entry value (the form used by the engine):
  TradingCalc canonical vectors 15 and 16 (https://tradingcalc.io/verify, MEXC help-center example):
  linear 25x, entry 8000, maintenance margin 0.5 % -> long 7720, short 8280.
* Net PnL: TradingCalc vector 1 (BTC long +10 %, 0.02 % open / 0.05 % close): gross 500, fees 3.75, net 496.25,
  computed with the same expression as ``execute_signal``.
"""
import math

import pytest

from bot.backtest.engine import liquidation_price
from bot.backtest.stats_tests import expected_max_sharpe, probabilistic_sharpe


def test_dsr_paper_example():
    sr0 = expected_max_sharpe(100, 0.5 / 250)
    assert sr0 == pytest.approx(0.1132, abs=1e-4)
    dsr = probabilistic_sharpe(2.5 / math.sqrt(250), sr0, 1250, -3.0, 10.0)
    assert dsr == pytest.approx(0.9004, abs=1e-4)


@pytest.mark.parametrize("direction, expected", [(1, 7720.0), (-1, 8280.0)])
def test_liquidation_entry_value_form(direction, expected):
    risk = {"max_leverage": 25.0, "maintenance_margin_rate": 0.005}
    assert liquidation_price(8000.0, direction, risk) == pytest.approx(expected, abs=1e-9)


def test_net_pnl_expression():
    # same expression as execute_signal: d * (exit - entry) * size - entry_fee - exit_fee
    entry, exit_, size, d = 50_000.0, 55_000.0, 0.1, 1
    entry_fee = entry * size * 0.0002
    exit_fee = exit_ * size * 0.0005
    pnl = d * (exit_ - entry) * size - entry_fee - exit_fee
    assert entry_fee + exit_fee == pytest.approx(3.75)
    assert pnl == pytest.approx(496.25)
