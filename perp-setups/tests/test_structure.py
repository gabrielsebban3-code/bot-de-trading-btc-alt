"""Pivots (delayed confirmation), sweeps of equal highs/lows, structure break, FVG, order block."""
import numpy as np

from src import data, structure as st
from tests.conftest import T0, make_df, random_walk_df


def _series(highs):
    high = np.array(highs, dtype="float64")
    low = high - 1.0
    close = high - 0.5
    return high, low, close


def test_pivot_requires_n_candles_each_side_strictly():
    high = np.array([1, 2, 5, 2, 1, 3, 3, 1, 1], dtype="float64")
    low = high - 0.5
    is_ph, _ = st.pivot_flags(high, low, 2)
    assert is_ph[2]
    assert not is_ph[5] and not is_ph[6]      # equal highs are not strictly higher than each other
    assert not is_ph[0] and not is_ph[8]      # not enough candles on one side


def test_pivot_invisible_before_confirmation_candle():
    n = 3
    high = np.array([1, 2, 3, 9, 3, 2, 1, 1, 1, 1], dtype="float64")   # pivot high at index 3
    low = high - 0.5
    piv = st.confirmed_pivots(high, low, n)
    assert list(piv["ph_idx"]) == [3]
    level, idx = st.last_confirmed_level(len(high), piv["ph_idx"], piv["ph_level"], n)
    assert np.isnan(level[: 3 + n]).all() and (idx[: 3 + n] == -1).all()   # candles 0..5: invisible
    assert level[3 + n] == 9.0 and idx[3 + n] == 3                          # visible from candle 6
    # with history truncated before the close of candle pivot + n the pivot does not exist
    assert len(st.confirmed_pivots(high[: 3 + n], low[: 3 + n], n)["ph_idx"]) == 0
    assert list(st.confirmed_pivots(high[: 3 + n + 1], low[: 3 + n + 1], n)["ph_idx"]) == [3]


def test_pivots_never_change_when_future_candles_arrive():
    df = random_walk_df(3000, seed=3)
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    for n in (3, 5):
        full = st.confirmed_pivots(h, l, n)
        for cut in (500, 1777, 2500):
            part = st.confirmed_pivots(h[:cut], l[:cut], n)
            visible = full["ph_idx"][full["ph_conf"] <= cut - 1]
            assert list(part["ph_idx"]) == list(visible)
            visible_l = full["pl_idx"][full["pl_conf"] <= cut - 1]
            assert list(part["pl_idx"]) == list(visible_l)


def test_sweep_of_equal_highs_detected():
    #          0   1   2(P1) 3   4   5   6(P2)  7   8    9(sweep)
    highs = [10, 11, 12.0, 11, 10, 11, 11.99, 11, 10.5, 12.1]
    high, low, close = _series(highs)
    close[9] = 11.5                                   # wick above 12, close back below
    piv = st.confirmed_pivots(high, low, 2)
    assert list(piv["ph_idx"]) == [2, 6]
    assert st.find_sweeps(high, low, close, piv, "high") == [(9, 12.0)]


def test_single_pivot_is_not_a_liquidity_level():
    highs = [10, 11, 12.0, 11, 10, 11, 11.5, 11, 10.5, 12.1]     # second pivot 4 % lower: no equal highs
    high, low, close = _series(highs)
    close[9] = 11.9
    piv = st.confirmed_pivots(high, low, 2)
    assert st.find_sweeps(high, low, close, piv, "high") == []


def test_levels_further_than_tolerance_are_not_equal():
    highs = [10, 11, 12.0, 11, 10, 11, 11.97, 11, 10.5, 12.1]    # 0.25 % apart > 0.15 %
    high, low, close = _series(highs)
    close[9] = 11.5
    piv = st.confirmed_pivots(high, low, 2)
    assert st.find_sweeps(high, low, close, piv, "high") == []


def test_close_beyond_level_is_a_breakout_not_a_sweep():
    highs = [10, 11, 12.0, 11, 10, 11, 11.99, 11, 10.5, 12.6]
    high, low, close = _series(highs)                 # close[9] = 12.1 > level
    piv = st.confirmed_pivots(high, low, 2)
    assert st.find_sweeps(high, low, close, piv, "high") == []


def test_level_already_traded_through_is_not_swept_again():
    #          0   1   2(P1) 3   4   5(spike) 6   7   8(P2)  9   10   11
    highs = [10, 11, 12.0, 11, 10, 12.05,   11, 10, 11.99, 11, 10.5, 12.03]
    high, low, close = _series(highs)
    close[11] = 11.5
    piv = st.confirmed_pivots(high, low, 2)
    assert list(piv["ph_idx"]) == [2, 5, 8]
    assert st.find_sweeps(high, low, close, piv, "high") == []


def test_sweep_not_visible_before_second_pivot_is_confirmed():
    # the second equal high sits at index 6 and is confirmed at index 8: a "sweep" at 7 cannot exist
    highs = [10, 11, 12.0, 11, 10, 11, 11.99, 12.1, 10.5, 10.4, 10.3]
    high, low, close = _series(highs)
    close[7] = 11.5
    piv = st.confirmed_pivots(high, low, 2)
    assert st.find_sweeps(high, low, close, piv, "high") == []


def test_sweep_of_equal_lows_detected():
    lows = [12, 11, 10.0, 11, 12, 11, 10.01, 11, 11.5, 9.9]
    low = np.array(lows, dtype="float64")
    high = low + 1.0
    close = low + 0.5
    close[9] = 10.4                                   # wick below 10, close back above
    piv = st.confirmed_pivots(high, low, 2)
    assert list(piv["pl_idx"]) == [2, 6]
    assert st.find_sweeps(high, low, close, piv, "low") == [(9, 10.0)]


def test_mss_first_close_beyond_reference_and_displacement():
    o = np.array([10, 10, 10.0, 9.9, 9.5], dtype="float64")
    c = np.array([10, 10, 9.9, 9.5, 9.0], dtype="float64")
    h = np.maximum(o, c) + 0.05
    l = np.minimum(o, c) - 0.05
    atr = np.full(5, 0.2)
    # short setup, sweep at 1, reference pivot low 9.8, stop 10.5
    assert st.find_mss(1, -1, 9.8, 10.5, o, h, l, c, atr) == 3
    # displacement: body of candle 3 is 0.4 >= 1.5 * 0.2 -> accepted ; with a bigger ATR -> rejected
    assert st.find_mss(1, -1, 9.8, 10.5, o, h, l, c, atr, require_displacement=True) == 3
    assert st.find_mss(1, -1, 9.8, 10.5, o, h, l, c, np.full(5, 0.3), require_displacement=True) == -1
    # stop touched before the break -> dropped
    assert st.find_mss(1, -1, 9.8, 10.04, o, h, l, c, atr) == -1
    # break outside the window -> dropped
    assert st.find_mss(1, -1, 9.8, 10.5, o, h, l, c, atr, window=1) == -1


def test_fvg_and_order_block_zones():
    #            i-1    i     i+1
    high = np.array([10.0, 9.8, 9.2])
    low = np.array([9.7, 9.0, 8.9])
    assert st.fvg_zone(1, -1, high, low) == (9.2, 9.7)          # bearish gap: high[i+1] .. low[i-1]
    assert st.fvg_zone(1, 1, high, low) is None
    assert st.fvg_zone(1, -1, np.array([10.0, 9.8, 9.75]), low) is None   # candles overlap: no gap
    o = np.array([9.0, 9.5, 9.9, 9.8])
    c = np.array([9.5, 9.9, 9.8, 9.0])        # bullish, bullish, bearish, bearish(displacement at 3)
    bull, bear = st.last_opposite_candle(o, c)
    assert st.order_block_zone(3, -1, o, c, bull, bear) == (9.5, 9.9)   # last bullish candle before 3 is candle 1
    assert st.order_block_zone(3, 1, o, c, bull, bear) == (9.8, 9.9)    # last bearish candle before 3 is candle 2


def test_htf_candle_not_usable_before_its_close():
    """A 4h candle is only visible once its 16 fifteen-minute candles are closed."""
    df = random_walk_df(16 * 12, seed=5, start_ms=T0)
    b15 = data.resample(df, "15m")
    b4h = data.resample(df, "4h")
    assert len(b4h) == 12
    aligned = data.align_htf(b15["close_time"].to_numpy(), b4h["close_time"].to_numpy(), b4h["close"].to_numpy())
    close4h = b4h["close"].to_numpy()
    for k in range(len(b15)):
        closed = (k + 1) // 16                      # number of 4h candles fully closed when 15m candle k closes
        if closed == 0:
            assert np.isnan(aligned[k])
        else:
            assert aligned[k] == close4h[closed - 1]
    # the 15m candle closing 15 minutes before the 4h close still sees the PREVIOUS 4h candle
    assert aligned[30] == close4h[0] and aligned[31] == close4h[1]
    # changing the last 15m candle of a 4h candle must not change anything visible before its close
    df2 = df.copy()
    df2.loc[31, ["high", "close"]] = df2.loc[31, "high"] * 1.5
    b4h2 = data.resample(df2, "4h")
    aligned2 = data.align_htf(b15["close_time"].to_numpy(), b4h2["close_time"].to_numpy(), b4h2["close"].to_numpy())
    assert np.array_equal(aligned[:31], aligned2[:31], equal_nan=True)
    assert aligned2[31] != aligned[31]


def test_resample_drops_incomplete_candles():
    df = make_df([(1, 2, 0.5, 1.5)] * 16, start_ms=T0)
    df = df.drop(index=5).reset_index(drop=True)       # one missing 15m candle in the second hour
    b1h = data.resample(df, "1h")
    assert len(b1h) == 3                                # the hour with the hole is not built
    assert list(b1h["contig"]) == [False, False, True]
    assert len(data.resample(df, "4h")) == 0
