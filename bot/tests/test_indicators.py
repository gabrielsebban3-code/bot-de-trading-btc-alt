import numpy as np
import pytest

from bot.indicators._core import rolling_prev, sma
from bot.indicators.derivatives import funding_zscore, oi_change
from bot.indicators.momentum import macd, rsi
from bot.indicators.trend import adx, donchian, ema
from bot.indicators.volatility import atr, bollinger, true_range
from bot.indicators.volume import relative_volume, session_vwap
from bot.tests.conftest import make_bars, random_walk


def test_ema_seed_and_recursion():
    x = np.array([1, 2, 3, 4, 5], dtype=float)
    e = ema(x, 3)
    assert np.isnan(e[:2]).all()
    assert e[2] == pytest.approx(2.0)
    assert e[3] == pytest.approx(2.0 + 0.5 * (4 - 2.0))
    assert e[4] == pytest.approx(3.0 + 0.5 * (5 - 3.0))


def test_atr_wilder_by_hand():
    h = np.array([10, 11, 12, 13], dtype=float)
    l = np.array([9, 10, 11, 12], dtype=float)
    c = np.array([9.5, 10.5, 11.5, 12.5], dtype=float)
    tr = true_range(h, l, c)
    assert np.isnan(tr[0]) and tr[1:].tolist() == [1.5, 1.5, 1.5]
    a = atr(h, l, c, 2)
    assert np.isnan(a[:2]).all() and a[2] == pytest.approx(1.5) and a[3] == pytest.approx(1.5)


def test_rsi_flat_and_monotonic():
    assert rsi(np.full(30, 5.0), 14)[-1] == 50.0
    assert rsi(np.arange(30, dtype=float), 14)[-1] == 100.0


def test_donchian_excludes_current_candle():
    h = np.array([1, 2, 3, 10, 4], dtype=float)
    hi, lo = donchian(h, h, 3)
    assert np.isnan(hi[:3]).all()
    assert hi[3] == 3.0 and hi[4] == 10.0


def test_funding_zscore_uses_previous_settlements_only():
    r = np.array([0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 5.0])
    z = funding_zscore(r, 3)
    win = r[3:6]
    assert z[6] == pytest.approx((5.0 - win.mean()) / win.std(ddof=1))


def test_oi_change():
    assert oi_change(np.array([100.0, 50.0]), 1)[1] == pytest.approx(-0.5)


def test_session_vwap_resets_daily():
    df = make_bars(np.full(200, 10.0), tf_ms=15 * 60_000)
    v = session_vwap(df["open_time"], df["high"], df["low"], df["close"], df["volume"], "1d")
    assert np.allclose(v, (df["high"] + df["low"] + df["close"]) / 3)


@pytest.mark.parametrize("cut", [50, 137, 260])
def test_indicators_are_causal(cut):
    """Values on the first `cut` candles are identical whether or not later candles exist."""
    df = make_bars(random_walk(400, seed=3))
    h, l, c, v = (df[k].to_numpy() for k in ("high", "low", "close", "volume"))
    fns = [
        lambda h, l, c, v: ema(c, 20), lambda h, l, c, v: atr(h, l, c, 14), lambda h, l, c, v: rsi(c, 3),
        lambda h, l, c, v: adx(h, l, c, 14), lambda h, l, c, v: donchian(h, l, 55)[0],
        lambda h, l, c, v: bollinger(c, 20, 2)[1], lambda h, l, c, v: macd(c)[2],
        lambda h, l, c, v: relative_volume(v, 20), lambda h, l, c, v: sma(c, 10),
        lambda h, l, c, v: rolling_prev(c, 5, "min"),
    ]
    for fn in fns:
        full = fn(h, l, c, v)
        part = fn(h[:cut], l[:cut], c[:cut], v[:cut])
        np.testing.assert_array_equal(full[:cut], part)
