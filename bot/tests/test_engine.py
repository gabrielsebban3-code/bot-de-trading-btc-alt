"""Hand-checked execution rules of the backtest engine (Step 6)."""
import copy

import numpy as np
import pandas as pd
import pytest

from bot.backtest.engine import Position, SymbolMarket, run_backtest
from bot.core.types import Direction, ExitKind, ExitRule, Signal
from bot.data.resampler import resample
from bot.risk.portfolio import Portfolio
from bot.risk.sizing import position_size
from bot.tests.conftest import M15, T0

H = 4 * M15
SLIP = 0.001


@pytest.fixture
def ecfg(cfg):
    c = copy.deepcopy(cfg)
    c["costs"]["slippage"] = {"base": SLIP, "atr_coef": 0.0, "impact_coef": 0.0, "atr_period": 14,
                              "adv_days": 30, "vol_days": 30}
    c["risk"].update(min_stop_pct=0.0, max_stop_pct=1.0, max_daily_loss_pct=None,
                     correlation={"enabled": False}, max_leverage=10.0)
    return c


def path(rows):
    """rows = [(o, h, l, c), ...] of consecutive 15m candles from T0."""
    a = np.array(rows, dtype=float)
    return pd.DataFrame({"open_time": T0 + np.arange(len(a), dtype="int64") * M15, "open": a[:, 0],
                         "high": a[:, 1], "low": a[:, 2], "close": a[:, 3], "volume": 1.0,
                         "quote_volume": 1.0, "trades": 1, "taker_buy_quote": 0.5})


def market(rows, cfg, funding=None, atr_period=1):
    df = path(rows)
    m = SymbolMarket("TESTUSDT", df, "15m", funding, None, cfg)
    m.add_tf("1h", resample(df, "15m", "1h"), atr_period=atr_period)
    return m


def sig(t, d=1, stop=None, offset=None, rule=None, order="market", entry=100.0, expiry=None, sym="TESTUSDT"):
    rule = rule or ExitRule(ExitKind.TAKE_PROFIT, tp_r=100.0, tf="1h")
    return Signal(symbol=sym, direction=Direction(d), concept="T", variant="v", tf_signal="1h", tf_context=None,
                  generated_at=t, entry=entry, order_type=order, stop=stop if stop is not None else entry - d * 2,
                  exit_rule=rule, stop_offset=offset, limit_expiry=expiry)


FLAT = (100, 100.5, 99.5, 100)


def test_market_entry_next_open_slippage_and_stop(ecfg):
    rows = [FLAT] * 4 + [(100, 100.5, 99.5, 100), (100, 100.2, 97.5, 98)] + [FLAT] * 4
    m = market(rows, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0)], {"TESTUSDT": m}, ecfg, T0, T0 + 10 * M15)
    t = tr.iloc[0]
    entry = 100 * (1 + SLIP)
    assert t["entry_price"] == pytest.approx(entry)
    assert t["initial_stop"] == pytest.approx(98.0)                 # stop placed from the fill (open 100)
    assert t["exit_reason"] == "stop"
    exit_px = 98.0 * (1 - SLIP)
    assert t["exit_price"] == pytest.approx(exit_px)
    size = 10000 * 0.01 / (entry - 98.0)
    fees = size * (entry + exit_px) * 0.0005
    assert t["pnl"] == pytest.approx(size * (exit_px - entry) - fees)
    assert t["r_multiple"] == pytest.approx(t["pnl"] / (size * (entry - 98.0)))


def test_gap_through_stop_fills_at_open(ecfg):
    rows = [FLAT] * 4 + [FLAT, (96, 96.5, 95, 96)] + [FLAT] * 2
    m = market(rows, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0)], {"TESTUSDT": m}, ecfg, T0, T0 + 8 * M15)
    assert tr.iloc[0]["exit_price"] == pytest.approx(96 * (1 - SLIP))


def test_stop_wins_when_stop_and_target_in_same_candle(ecfg):
    rule = ExitRule(ExitKind.TAKE_PROFIT, tp_price=101.0, tf="1h")
    rows = [FLAT] * 4 + [FLAT, (100, 102, 97, 100)] + [FLAT] * 2
    m = market(rows, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0, rule=rule)], {"TESTUSDT": m}, ecfg, T0, T0 + 8 * M15)
    assert tr.iloc[0]["exit_reason"] == "stop"


def test_target_needs_to_be_traded_through(ecfg):
    rule = ExitRule(ExitKind.TAKE_PROFIT, tp_price=101.0, tf="1h")
    rows = [FLAT] * 4 + [(100, 101.0, 99.5, 100), (100, 101.2, 99.5, 101)] + [FLAT] * 2
    m = market(rows, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0, rule=rule)], {"TESTUSDT": m}, ecfg, T0, T0 + 8 * M15)
    t = tr.iloc[0]
    assert t["exit_reason"] == "tp" and t["exit_time"] == T0 + 5 * M15
    assert t["exit_price"] == pytest.approx(101.0)                  # at the target, no slippage


def test_limit_fill_only_through_the_level(ecfg):
    rows = [FLAT] * 4 + [(100, 100.5, 99.0, 100), (100, 100.5, 98.9, 99)] + [FLAT] * 6
    m = market(rows, ecfg)
    s = sig(T0 + H, order="limit", entry=99.0, stop=97.0, expiry=T0 + 12 * M15)
    tr, _ = run_backtest([s], {"TESTUSDT": m}, ecfg, T0, T0 + 12 * M15)
    t = tr.iloc[0]
    assert t["entry_time"] == T0 + 5 * M15 and t["entry_price"] == 99.0   # touch at 99.0 is not a fill


def test_chandelier_moves_only_after_tf_close_and_never_back(ecfg):
    rule = ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=1.0, tf="1h")
    rows = ([FLAT] * 4 +
            [(100, 101, 99.95, 101), (101, 103, 99.9, 103), (103, 105, 102, 104), (104, 104.5, 103, 104)] +
            [(104, 104.2, 99.95, 100.5), (100.5, 100.6, 99.8, 100)] + [FLAT] * 2)
    m = market(rows, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0, rule=rule)], {"TESTUSDT": m}, ecfg, T0, T0 + 12 * M15)
    t = tr.iloc[0]
    # hour 1 TR = max(105 - 99.9, |105 - 100|, |99.9 - 100|) = 5.1 -> stop = 105 - 5.1 = 99.9 from hour 2 on.
    # 99.9 was reached inside hour 1 while the stop was still 98: no exit there.
    assert t["exit_reason"] == "trail"
    assert t["exit_time"] == T0 + 9 * M15
    assert t["exit_price"] == pytest.approx(99.9 * (1 - SLIP))
    assert t["stop_moves"] == 1


def test_data_gap_cancels_the_trade(ecfg):
    rows = [FLAT] * 9
    df = path(rows).drop(index=[6]).reset_index(drop=True)          # hole after the entry, data resumes later
    m = SymbolMarket("TESTUSDT", df, "15m", None, None, ecfg)
    m.add_tf("1h", resample(df, "15m", "1h"), atr_period=1)
    tr, info = run_backtest([sig(T0 + H, offset=2.0)], {"TESTUSDT": m}, ecfg, T0, T0 + 9 * M15)
    assert tr.empty and info["void_gap"] == 1


def test_open_position_closed_at_window_end(ecfg):
    m = market([FLAT] * 8, ecfg)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0)], {"TESTUSDT": m}, ecfg, T0, T0 + 8 * M15)
    t = tr.iloc[0]
    assert t["exit_reason"] == "end" and t["exit_time"] == T0 + 7 * M15
    assert t["exit_price"] == pytest.approx(100 * (1 - SLIP))


def test_funding_paid_by_long_at_mark_price(ecfg):
    fund = pd.DataFrame({"time": [T0 + 6 * M15, T0 + 50 * M15], "rate": [0.001, 0.5]})
    rows = [FLAT] * 6 + [(102, 102.5, 101.5, 102)] + [FLAT]
    m = market(rows, ecfg, funding=fund)
    tr, _ = run_backtest([sig(T0 + H, offset=2.0)], {"TESTUSDT": m}, ecfg, T0, T0 + 8 * M15)
    t = tr.iloc[0]
    assert t["funding"] == pytest.approx(t["size"] * 0.001 * 102)


def test_portfolio_one_position_per_pair_and_max_positions(ecfg):
    m = market([FLAT] * 16, ecfg)
    s1, s2 = sig(T0 + H, offset=2.0), sig(T0 + H + M15, offset=2.0)
    tr, info = run_backtest([s1, s2], {"TESTUSDT": m}, ecfg, T0, T0 + 16 * M15)
    assert len(tr) == 1 and info["skip_pair_busy"] == 1
    c = copy.deepcopy(ecfg)
    c["risk"]["max_positions"] = 1
    m2 = SymbolMarket("OTHERUSDT", path([FLAT] * 16), "15m", None, None, c)
    m2.add_tf("1h", resample(path([FLAT] * 16), "15m", "1h"), atr_period=1)
    s3 = sig(T0 + H + M15, offset=2.0, sym="OTHERUSDT")
    tr, info = run_backtest([s1, s3], {"TESTUSDT": m, "OTHERUSDT": m2}, c, T0, T0 + 16 * M15)
    assert len(tr) == 1 and info["skip_portfolio_full"] == 1


def test_correlated_group_cap_and_daily_loss(ecfg):
    c = copy.deepcopy(ecfg)
    c["risk"]["correlation"] = {"enabled": True, "max_same_direction": 1}
    pf = Portfolio(c, group_fn=lambda s, t: "btc_beta")
    a, b = sig(T0, sym="AUSDT"), sig(T0, sym="BUSDT")
    assert pf.refuse_reason(a, T0) is None
    pf.open(a, T0 + 10 * H, 0.0)
    assert pf.refuse_reason(b, T0) == "correlated"
    c2 = copy.deepcopy(ecfg)
    c2["risk"]["max_daily_loss_pct"] = 0.03
    pf2 = Portfolio(c2)
    pf2.open(a, T0 + M15, -400.0)                              # -4 % realised in the day
    pf2.release(T0 + 2 * M15)
    assert pf2.refuse_reason(b, T0 + 2 * M15) == "daily_loss"
    assert pf2.refuse_reason(b, T0 + 86_400_000) is None        # next UTC day


def test_position_size_leverage_cap():
    size, capped = position_size(10000, 0.01, 0.1, 100.0, 5.0)
    assert capped and size == pytest.approx(5 * 10000 / 100.0)
    size, capped = position_size(10000, 0.01, 2.0, 100.0, 5.0)
    assert not capped and size == pytest.approx(50.0)


def test_position_stop_never_moves_back():
    p = Position(1, 100.0, 98.0, ExitRule(ExitKind.TRAIL_CHANDELIER, atr_mult=1.0, tf="1h"), 0.0)
    p.observe_path(np.array([105.0]), np.array([99.0]))
    assert p.on_tf_close(1, 2.0) and p.stop == 103.0
    assert not p.on_tf_close(2, 10.0) and p.stop == 103.0       # wider ATR would lower it: ignored
