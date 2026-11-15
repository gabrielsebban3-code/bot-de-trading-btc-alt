"""Fill rules, costs, funding, sizing and portfolio constraints of the simulation engine."""
import numpy as np
import pandas as pd
import pytest

from src import data, engine
from tests.conftest import T0, flat, make_df, make_symbol, signal, signals_df

BAR = data.BAR_MS


def _run(cfg, bars, sigs, funding=None, symbol="TESTUSDT", cost_mult=1.0):
    df = make_df(bars)
    _, sd = make_symbol(df, cfg, funding, symbol)
    end = T0 + len(bars) * BAR
    return engine.run_backtest(signals_df(sigs), {symbol: sd}, cfg, T0, end, "X", "x", cost_mult)


# ------------------------------------------------------------------ fills

def test_market_order_fills_at_next_open_with_slippage(cfg):
    bars = [(100, 100, 100, 100), (101, 101.5, 100.8, 101), (101, 101, 101, 101)]
    trades, _ = _run(cfg, bars, [signal(T0 + BAR, 1, stop_dist=2.0)])
    t = trades.iloc[0]
    assert t.entry_time == pd.Timestamp(T0 + BAR, unit="ms", tz="UTC")       # candle after the signal candle
    assert t.entry_price == pytest.approx(101 * 1.0003)                        # open + adverse slippage
    assert t.stop_price == pytest.approx(99.0)


def test_limit_touched_but_not_traded_through_is_not_filled(cfg_nocost):
    bars = [(105, 105, 105, 105),
            (105, 105, 100.0, 103),     # low == limit: touch only -> no fill
            (103, 104, 99.9, 102),      # low < limit: fill at 100
            (102, 107, 101, 106.5)]     # take-profit at 106 traded through
    s = signal(T0 + BAR, 1, order_type="limit", limit_price=100.0, stop_price=97.0, tp_r=2.0,
               expiry_ms=T0 + 20 * BAR)
    trades, info = _run(cfg_nocost, bars, [s])
    t = trades.iloc[0]
    assert t.entry_time == pd.Timestamp(T0 + 2 * BAR, unit="ms", tz="UTC")
    assert t.entry_price == 100.0 and t.exit_reason == "tp" and t.exit_price == 106.0
    assert t.r_multiple_net == pytest.approx(2.0)
    # touch only, then expiry -> no trade at all
    trades, info = _run(cfg_nocost, bars[:2] + flat(103, 4), [dict(s, expiry_ms=T0 + 4 * BAR)])
    assert len(trades) == 0 and info["limit_expired"] == 1


def test_sell_limit_needs_high_strictly_above(cfg_nocost):
    bars = [(95, 95, 95, 95), (95, 100.0, 95, 96), (96, 100.01, 95, 96), (96, 96, 96, 96)]
    s = signal(T0 + BAR, -1, order_type="limit", limit_price=100.0, stop_price=103.0, tp_r=2.0,
               expiry_ms=T0 + 20 * BAR)
    trades, _ = _run(cfg_nocost, bars, [s])
    assert trades.iloc[0].entry_time == pd.Timestamp(T0 + 2 * BAR, unit="ms", tz="UTC")


def test_limit_order_expires_after_validity(cfg_nocost):
    # limit valid for candles 1..3 only ; price trades through on candle 4 -> no fill
    bars = [(105, 105, 105, 105)] * 4 + [(105, 105, 99, 100), (100, 100, 100, 100)]
    s = signal(T0 + BAR, 1, order_type="limit", limit_price=100.0, stop_price=97.0, tp_r=2.0,
               expiry_ms=T0 + 4 * BAR)
    trades, info = _run(cfg_nocost, bars, [s])
    assert len(trades) == 0 and info["limit_expired"] == 1


def test_take_profit_touched_but_not_traded_through_is_not_filled(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 104.0, 99.5, 103), (103, 104.01, 102, 104), (104, 104, 104, 104)]
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0)])   # tp = 104
    t = trades.iloc[0]
    assert t.exit_reason == "tp" and t.exit_time == pd.Timestamp(T0 + 2 * BAR, unit="ms", tz="UTC")


def test_stop_wins_when_stop_and_tp_in_same_candle(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 105, 97, 101), (101, 101, 101, 101)]
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0)])
    t = trades.iloc[0]
    assert t.exit_reason == "stop" and t.exit_price == 98.0
    assert t.r_multiple_net == pytest.approx(-1.0)
    # same for a short
    bars = [(100, 100, 100, 100), (100, 103, 95, 99), (99, 99, 99, 99)]
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, -1, stop_dist=2.0, tp_r=2.0)])
    assert trades.iloc[0].exit_reason == "stop" and trades.iloc[0].exit_price == 102.0


def test_no_take_profit_on_the_candle_of_a_limit_fill(cfg_nocost):
    # the fill candle also trades above the target: order of events unknown -> target not counted
    bars = [(105, 105, 105, 105), (105, 107, 99.5, 101), (101, 101.5, 100.5, 101), (101, 101, 96, 96)]
    s = signal(T0 + BAR, 1, order_type="limit", limit_price=100.0, stop_price=97.0, tp_r=2.0,
               expiry_ms=T0 + 20 * BAR)
    trades, _ = _run(cfg_nocost, bars, [s])
    t = trades.iloc[0]
    assert t.exit_reason == "stop" and t.exit_time == pd.Timestamp(T0 + 3 * BAR, unit="ms", tz="UTC")


def test_stop_gap_is_filled_at_the_open(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (96, 96.5, 95, 96), (96, 96, 96, 96)]
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0)])
    t = trades.iloc[0]
    assert t.exit_reason == "stop" and t.exit_price == 96.0       # open beyond the stop (98)
    assert t.r_multiple_net == pytest.approx(-2.0)


def test_time_exit_at_open_after_max_hold(cfg_nocost):
    bars = [(100, 100, 100, 100)] + [(100, 100.5, 99.5, 100.2)] * 3 + [(100.4, 100.6, 100.3, 100.5)] * 3
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0, max_hold_ms=3 * BAR)])
    t = trades.iloc[0]
    assert t.exit_reason == "time" and t.exit_price == 100.4
    assert t.exit_time == pd.Timestamp(T0 + 4 * BAR, unit="ms", tz="UTC") and t.bars_held == 3


def test_stop_distance_filter(cfg_nocost):
    bars = flat(100, 6)
    for dist, taken in ((0.2, 0), (0.31, 1), (5.9, 1), (6.1, 0)):   # 0.3 % .. 6 % of the entry price
        trades, info = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=dist)])
        assert len(trades) == taken
        assert info["skip_filter"] == 1 - taken


def test_trade_touching_a_data_gap_is_ignored(cfg_nocost):
    df = make_df(flat(100, 12))
    df = df.drop(index=6).reset_index(drop=True)          # hole while the position is open
    _, sd = make_symbol(df, cfg_nocost)
    sig = signals_df([signal(T0 + BAR, 1, stop_dist=2.0)])
    trades, info = engine.run_backtest(sig, {"TESTUSDT": sd}, cfg_nocost, T0, T0 + 12 * BAR, "X", "x")
    assert len(trades) == 0 and info["void_gap"] == 1


def test_open_position_closed_at_last_candle_of_the_set(cfg_nocost):
    bars = flat(100, 3) + [(100, 101, 99.9, 100.8)] * 3
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0)])
    t = trades.iloc[0]
    assert t.exit_reason == "time" and t.exit_price == 100.8


# ------------------------------------------------------------------ trailing stop

def test_chandelier_stop_uses_closed_candles_and_never_moves_back(cfg_nocost):
    highs = [100, 102, 104, 103, 101, 101]
    df = make_df([(h - 0.5, h, h - 1.0, h - 0.5) for h in highs])
    _, sd = make_symbol(df, cfg_nocost)
    sd.add_tf("15m", sd.ot, sd.h, sd.l, np.ones(len(highs)))             # ATR = 1 everywhere
    stops, carry, ext = engine._trail_stops(sd, "15m", 0, 0, 5, 1, 3.0, 98.0, -np.inf)
    # candle 0 uses the initial stop ; candle m uses highest high of candles < m minus 3 ATR, never lower
    assert list(stops) == [98.0, 98.0, 99.0, 101.0, 101.0]
    assert carry == 101.0 and ext == 104.0
    # short side mirrors it
    sd.add_tf("15m", sd.ot, sd.h, sd.l, np.ones(len(highs)))
    lows = sd.l
    stops, _, _ = engine._trail_stops(sd, "15m", 0, 0, 5, -1, 3.0, 110.0, np.inf)
    expected = [110.0]
    run = 110.0
    for m in range(4):
        run = min(run, lows[: m + 1].min() + 3.0)
        expected.append(run)
    assert list(stops) == expected


def test_trailing_exit_reason_and_price(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 101, 99.5, 101), (101, 106, 100.9, 105.5), (105.5, 105.6, 102.0, 102.5),
            (102.5, 102.6, 102.4, 102.5)]
    df = make_df(bars)
    _, sd = make_symbol(df, cfg_nocost)
    sd.add_tf("15m", sd.ot, sd.h, sd.l, np.ones(len(bars)))
    sig = signals_df([signal(T0 + BAR, 1, stop_dist=2.0, trail_mult=3.0)])
    trades, _ = engine.run_backtest(sig, {"TESTUSDT": sd}, cfg_nocost, T0, T0 + len(bars) * BAR, "X", "x")
    t = trades.iloc[0]
    # after candle 2 closes (high 106) the stop is 103 ; candle 3 trades down to 102 -> exit at 103
    assert t.exit_reason == "trail" and t.exit_price == 103.0
    assert t.stop_price == 98.0 and np.isnan(t.tp_price)


# ------------------------------------------------------------------ costs

def test_fees_and_slippage_market_entry_take_profit_exit(cfg):
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (100, 105, 99.5, 104.5), (104, 104, 104, 104)]
    trades, _ = _run(cfg, bars, [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0)])
    t = trades.iloc[0]
    entry = 100 * 1.0003                       # taker + slippage
    r = entry - 98.0
    tp = entry + 2 * r                         # maker, no slippage
    size = 10_000 * 0.01 / r
    assert t.entry_price == pytest.approx(entry) and t.exit_price == pytest.approx(tp)
    assert t["size"] == pytest.approx(size)
    assert t.fees == pytest.approx(size * (entry * 0.0005 + tp * 0.0002))
    assert t.slippage == pytest.approx(size * 100 * 0.0003)
    assert t.pnl_usdt == pytest.approx(size * (tp - entry) - t.fees)
    assert t.r_multiple_net == pytest.approx(t.pnl_usdt / (size * r))


def test_fees_and_slippage_on_both_sides_for_a_stop(cfg):
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (100, 100.2, 97, 98), (98, 98, 98, 98)]
    trades, _ = _run(cfg, bars, [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0)])
    t = trades.iloc[0]
    entry, exit_ = 100 * 1.0003, 98 * (1 - 0.0003)      # adverse slippage on both sides
    size = 100 / (entry - 98.0)
    assert t.exit_price == pytest.approx(exit_)
    assert t.fees == pytest.approx(size * (entry + exit_) * 0.0005)            # taker twice
    assert t.slippage == pytest.approx(size * (100 * 0.0003 + 98 * 0.0003))
    assert t.r_multiple_net < -1.0
    # short: slippage is adverse too (sell lower, buy back higher)
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (100, 103, 99.8, 102), (102, 102, 102, 102)]
    trades, _ = _run(cfg, bars, [signal(T0 + BAR, -1, stop_dist=2.0, tp_r=2.0)])
    t = trades.iloc[0]
    assert t.entry_price == pytest.approx(100 * (1 - 0.0003))
    assert t.exit_price == pytest.approx(102 * 1.0003)


def test_limit_entry_pays_maker_fee_without_slippage(cfg):
    bars = [(105, 105, 105, 105), (105, 105, 99, 101), (101, 107, 100.5, 106.5), (106, 106, 106, 106)]
    s = signal(T0 + BAR, 1, order_type="limit", limit_price=100.0, stop_price=97.0, tp_r=2.0,
               expiry_ms=T0 + 20 * BAR)
    trades, _ = _run(cfg, bars, [s])
    t = trades.iloc[0]
    size = 100 / 3.0
    assert t.entry_price == 100.0 and t.exit_price == 106.0 and t.slippage == 0.0
    assert t.fees == pytest.approx(size * (100 + 106) * 0.0002)                # maker twice


def test_cost_multiplier_doubles_fees_and_slippage(cfg):
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (100, 100.2, 97, 98), (98, 98, 98, 98)]
    sig = [signal(T0 + BAR, 1, stop_dist=2.0, tp_r=2.0)]
    t1 = _run(cfg, bars, sig)[0].iloc[0]
    t2 = _run(cfg, bars, sig, cost_mult=2.0)[0].iloc[0]
    assert t2.entry_price == pytest.approx(100 * 1.0006)
    assert t2.fees / t2["size"] == pytest.approx((t2.entry_price + t2.exit_price) * 0.001)
    assert t2.r_multiple_net < t1.r_multiple_net


# ------------------------------------------------------------------ funding

def _funding(times_rates):
    return pd.DataFrame({"funding_time": [t for t, _ in times_rates], "funding_rate": [r for _, r in times_rates]})


def test_funding_sign_long_pays_positive_rate_short_receives(cfg_nocost):
    bars = flat(100, 10)
    fund = _funding([(T0 + 4 * BAR + 3, 0.001)])                 # settlement while the position is open
    for direction, sign in ((1, 1.0), (-1, -1.0)):
        trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, direction, stop_dist=2.0, max_hold_ms=6 * BAR)], fund)
        t = trades.iloc[0]
        assert t.funding == pytest.approx(sign * t.notional * 0.001)     # > 0 = paid, < 0 = received
        assert t.pnl_usdt == pytest.approx(-t.funding)
    # negative rate: the long receives
    fund = _funding([(T0 + 4 * BAR, -0.002)])
    trades, _ = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0, max_hold_ms=6 * BAR)], fund)
    assert trades.iloc[0].pnl_usdt == pytest.approx(trades.iloc[0].notional * 0.002)


def test_funding_only_for_settlements_crossed_while_in_position(cfg_nocost):
    bars = flat(100, 12)
    sig = [signal(T0 + BAR, 1, stop_dist=2.0, max_hold_ms=6 * BAR)]      # in position: candles 1 .. 7 (exit at open)
    cases = [
        (T0, 0.0),                # before the entry
        (T0 + BAR, 0.0),          # exactly at the entry candle open: the order is filled just after -> not paid
        (T0 + 2 * BAR, 1.0),      # inside
        (T0 + 7 * BAR, 1.0),      # at the open of the exit candle: still in position -> paid
        (T0 + 8 * BAR, 0.0),      # after the exit
    ]
    for when, expected in cases:
        trades, _ = _run(cfg_nocost, bars, sig, _funding([(when, 0.001)]))
        t = trades.iloc[0]
        assert t.funding == pytest.approx(expected * t.notional * 0.001), when
    # two settlements crossed -> both applied
    trades, _ = _run(cfg_nocost, bars, sig, _funding([(T0 + 2 * BAR, 0.001), (T0 + 5 * BAR, 0.0005)]))
    assert trades.iloc[0].funding == pytest.approx(trades.iloc[0].notional * 0.0015)


# ------------------------------------------------------------------ sizing and portfolio

def test_position_size_risks_one_percent_of_current_capital(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 100.5, 97, 98)] + flat(98, 3) + [(98, 98.2, 95, 96), (96, 96, 96, 96)]
    sigs = [signal(T0 + BAR, 1, stop_dist=2.0), signal(T0 + 5 * BAR, 1, stop_dist=2.0)]
    trades, _ = _run(cfg_nocost, bars, sigs)
    t1, t2 = trades.iloc[0], trades.iloc[1]
    assert t1["size"] == pytest.approx(10_000 * 0.01 / 2.0)
    assert t1.pnl_usdt == pytest.approx(-100.0) and t1.risk_pct_actual == pytest.approx(0.01)
    # second trade is sized on the capital after the first loss (9 900)
    assert t2["size"] == pytest.approx(9_900 * 0.01 / 2.0)
    assert t2.pnl_usdt == pytest.approx(-99.0)


def test_leverage_cap_reduces_size(cfg_nocost):
    cfg_nocost["engine"]["min_stop_pct"] = 0.0005
    bars = flat(100, 6)
    trades, info = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=0.1)])   # 1 % risk would need 10x
    t = trades.iloc[0]
    assert t.notional == pytest.approx(5 * 10_000)                # capped at 5x the capital
    assert t.risk_pct_actual == pytest.approx(0.005)              # real risk below 1 %, recorded
    assert info["leverage_capped"] == 1


def test_default_filters_never_need_more_than_5x(cfg):
    # with a 0.3 % minimum stop distance, 1 % risk means at most 3.33x leverage
    assert cfg["engine"]["risk_per_trade"] / cfg["engine"]["min_stop_pct"] <= cfg["engine"]["max_leverage"]


def test_liquidation_when_gap_exceeds_margin(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 100.5, 99.5, 100), (70, 71, 69, 70), (70, 70, 70, 70)]
    trades, info = _run(cfg_nocost, bars, [signal(T0 + BAR, 1, stop_dist=2.0)])
    t = trades.iloc[0]
    assert t.exit_reason == "liquidation" and info["liquidations"] == 1
    assert t.pnl_usdt == pytest.approx(-t.notional / 5.0)          # the isolated margin is lost, not more


def test_one_position_per_pair_and_five_in_total(cfg_nocost):
    names = [f"S{i}USDT" for i in range(7)]
    market, rows = {}, []
    for name in names:
        _, sd = make_symbol(make_df(flat(100, 12)), cfg_nocost, symbol=name)
        market[name] = sd
    for name in reversed(names):                                   # deliberately not in alphabetical order
        rows.append(signal(T0 + BAR, 1, stop_dist=2.0, symbol=name))
    rows.append(signal(T0 + 2 * BAR, 1, stop_dist=2.0, symbol="S0USDT"))    # pair already in position
    trades, info = engine.run_backtest(signals_df(rows), market, cfg_nocost, T0, T0 + 12 * BAR, "X", "x")
    assert sorted(trades["symbole"]) == names[:5]                  # alphabetical order decides
    assert info["skip_portfolio_full"] == 2 and info["skip_pair_busy"] == 1


def test_slot_is_free_again_after_exit(cfg_nocost):
    bars = [(100, 100, 100, 100), (100, 100.5, 97, 98), (98, 98, 98, 98), (98, 98, 98, 98), (98, 98, 98, 98)]
    sigs = [signal(T0 + BAR, 1, stop_dist=2.0), signal(T0 + BAR, 1, stop_dist=2.0), signal(T0 + 2 * BAR, 1, stop_dist=2.0)]
    trades, info = _run(cfg_nocost, bars, sigs)
    assert len(trades) == 2 and info["skip_pair_busy"] == 1


def test_trade_csv_columns(cfg):
    trades, _ = _run(cfg, flat(100, 6), [signal(T0 + BAR, 1, stop_dist=2.0)])
    expected = ["trade_id", "famille", "config_id", "symbole", "direction", "signal_time", "entry_time",
                "entry_price", "stop_price", "tp_price", "exit_time", "exit_price", "exit_reason", "size",
                "notional", "fees", "slippage", "funding", "pnl_usdt", "r_multiple_net", "bars_held"]
    assert list(trades.columns)[: len(expected)] == expected
