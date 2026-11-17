"""Study 8: the DCA and grid simulators follow their written rules on hand-built price paths."""
import numpy as np
import pytest

from src import etude8

CS = {"maker_fee": 0.0002, "taker_fee": 0.0005, "slippage": 0.0002}
FX_D = {"rsi_period": 14, "rsi_start": 30, "max_safety_orders": 5, "volume_scale": 1.5}
FX_G = {"stop_below_range": 0.05, "min_step": 0.003}
H = 3_600_000


def bars(path):
    a = np.asarray(path, dtype=float)
    return a[:, 0], a[:, 1], a[:, 2], a[:, 3]


def test_dca_base_order_safety_order_and_take_profit():
    # bar0 signal (rsi < 30) -> base at open of bar1 (100); bar2 drops to 97.5 (fills SO1 at 98); bar3 high hits TP
    o, h, l, c = bars([(100, 100, 100, 100), (100, 100.5, 99.5, 100), (99, 99, 97.5, 98), (98, 101, 98, 100.5), (100, 100, 100, 100)])
    rsi = np.array([20, 50, 50, 50, 50.0])
    eq, expo, n = etude8.sim_dca(o, h, l, c, rsi, np.zeros(5), np.ones(5, bool),
                                 {"step": 0.02, "take_profit": 0.015, "stop": "none"}, FX_D, CS)
    base = 1 / sum(1.5 ** k for k in range(6))
    u = base / (100 * 1.0002) + 1.5 * base / 98
    cost = 2.5 * base
    tp = cost / u * 1.015
    assert tp < 101 and n == 1
    expected = u * tp * (1 - 0.0002) - cost - base * 0.0005 - 1.5 * base * 0.0002
    assert eq[3] == pytest.approx(expected) and expo[4] == 0
    assert eq[0] == 0 and eq[1] == pytest.approx(base / 100.02 * 100 - base - base * 0.0005)


def test_dca_no_take_profit_in_the_bar_of_a_safety_fill_and_stop_fills_orders_above_it():
    o, h, l, c = bars([(100, 100, 100, 100), (100, 100, 100, 100), (99, 103, 97.9, 99), (99, 99, 70, 71), (71, 71, 71, 71)])
    rsi = np.array([20, 50, 50, 50, 50.0])
    p = {"step": 0.02, "take_profit": 0.015, "stop": 0.25}
    eq, expo, n = etude8.sim_dca(o, h, l, c, rsi, np.zeros(5), np.ones(5, bool), p, FX_D, CS)
    assert expo[2] > 0                                   # high 103 would have hit the TP, but an order filled first
    assert n == 1 and expo[3] == 0                       # stopped at 75 after the remaining orders filled
    base = 1 / sum(1.5 ** k for k in range(6))
    sizes = [base * 1.5 ** k for k in range(6)]
    prices = [100 * 1.0002] + [100 * (1 - 0.02 * k) for k in range(1, 6)]
    units = sum(sz / px for sz, px in zip(sizes, prices))
    fees = base * 0.0005 + sum(sizes[1:]) * 0.0002
    assert eq[3] == pytest.approx(units * 75 * (1 - 0.0002) * (1 - 0.0005) - 1.0 - fees) and eq[3] == pytest.approx(eq[4])


def test_grid_buys_below_sells_one_level_up_and_resets_on_monday():
    day0 = (1_800_000_000_000 // (24 * H)) * 24 * H
    while ((day0 // (24 * H)) + 3) % 7 != 0:
        day0 += 24 * H                                    # first Monday 00:00 UTC
    look = 7 * 24
    n = look + 6
    ot = day0 - look * H + np.arange(n) * H
    o = np.full(n, 105.0); h = np.full(n, 110.0); l = np.full(n, 100.0); c = np.full(n, 105.0)
    j = look                                              # Monday bar: range [100, 110], 10 levels
    o[j:] = 105.0; h[j] = 105.0; l[j] = 103.0; c[j] = 104.0          # buys the levels in [103, 105)
    h[j + 1] = 106.5; l[j + 1] = 104.0; c[j + 1] = 106.0             # sells them one level up
    o[j + 2:] = h[j + 2:] = l[j + 2:] = c[j + 2:] = 106.0             # then nothing moves
    eq, expo, sells = etude8.sim_grid(o, h, l, c, ot, np.zeros(n), np.ones(n, bool),
                                      {"levels": 10, "lookback_days": 7}, FX_G, CS)
    step = (110 / 100) ** 0.1 - 1
    lv = 100 * (1 + step) ** np.arange(11)
    bought = [i for i in range(10) if 103 <= lv[i] < 105]
    assert expo[j] > 0 and sells == len(bought) and expo[j + 1] == pytest.approx(0)
    gain = sum(0.1 / lv[i] * lv[i + 1] * (1 - 0.0002) - 0.1 - 0.1 * 0.0002 for i in bought)
    assert eq[j + 1] == pytest.approx(gain)
    assert np.all(expo[:j] == 0)                          # nothing before the first Monday
