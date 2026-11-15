"""Indicators against reference values computed by hand on a tiny dataset."""
import numpy as np
import pytest

from src import indicators as ind

# (high, low, close) of six candles used for ATR / ADX
H = np.array([10.0, 11.0, 10.8, 12.0, 11.9, 11.5])
L = np.array([9.0, 9.5, 10.0, 10.2, 11.0, 10.5])
C = np.array([9.5, 10.5, 10.2, 11.8, 11.2, 10.6])


def test_ema_hand_values():
    # period 3: seed = mean(1,2,3) = 2 at index 2, alpha = 0.5 -> 3, then 4
    out = ind.ema(np.array([1.0, 2.0, 3.0, 4.0, 5.0]), 3)
    assert np.isnan(out[:2]).all()
    assert out[2:] == pytest.approx([2.0, 3.0, 4.0])
    # non trivial: [2, 4, 9, 1] period 2 -> seed 3, alpha 2/3 -> 3 + 2/3*6 = 7, 7 + 2/3*(1-7) = 3
    assert ind.ema(np.array([2.0, 4.0, 9.0, 1.0]), 2)[1:] == pytest.approx([3.0, 7.0, 3.0])


def test_true_range_and_wilder_atr_hand_values():
    # TR by hand: 1.5, 0.8, 1.8, 0.9, 1.0 (index 0 undefined)
    tr = ind.true_range(H, L, C)
    assert np.isnan(tr[0])
    assert tr[1:] == pytest.approx([1.5, 0.8, 1.8, 0.9, 1.0])
    # ATR(3): index 3 = (1.5+0.8+1.8)/3 ; index 4 = (2*ATR3 + 0.9)/3 ; index 5 = (2*ATR4 + 1.0)/3
    atr = ind.atr(H, L, C, 3)
    assert np.isnan(atr[:3]).all()
    assert atr[3:] == pytest.approx([1.3666667, 1.2111111, 1.1407407], abs=1e-6)


def test_rsi_hand_values():
    # deltas +1, -0.5, +1, +0.5, -1 ; period 3
    close = np.array([10.0, 11.0, 10.5, 11.5, 12.0, 11.0])
    out = ind.rsi(close, 3)
    assert np.isnan(out[:3]).all()
    # idx3: avg gain 2/3, avg loss 0.5/3 -> RS 4 -> 80
    # idx4: gain (2/3*2+0.5)/3, loss (0.5/3*2)/3 -> RS 5.5 -> 84.615385
    # idx5: gain = loss = 0.407407 -> 50
    assert out[3:] == pytest.approx([80.0, 84.6153846, 50.0], abs=1e-6)


def test_rsi_all_gains_is_100():
    assert ind.rsi(np.array([1.0, 2.0, 3.0, 4.0, 5.0]), 3)[3:] == pytest.approx([100.0, 100.0])


def test_adx_hand_values():
    # period 2. +DM = [1, 0, 1.2, 0, 0], -DM = [0, 0, 0, 0, 0.5], TR = [1.5, 0.8, 1.8, 0.9, 1.0]
    # smoothed TR: 1.15, 1.475, 1.1875, 1.09375 ; +DM: 0.5, 0.85, 0.425, 0.2125 ; -DM: 0, 0, 0, 0.25
    # DX: 100, 100, 100, 100*|0.2125-0.25|/0.4625 = 8.108108
    # ADX: idx3 = mean(100, 100) = 100 ; idx4 = 100 ; idx5 = 100 + (8.108108 - 100)/2 = 54.054054
    out = ind.adx(H, L, C, 2)
    assert np.isnan(out[:3]).all()
    assert out[3:] == pytest.approx([100.0, 100.0, 54.0540541], abs=1e-6)


def test_bollinger_hand_values():
    # period 3, k = 2 on closes 9.5, 10.5, 10.2 : mean 10.0666667, population sd 0.4189936
    mid, upper, lower = ind.bollinger(np.array([9.5, 10.5, 10.2, 11.8]), 3, 2.0)
    assert np.isnan(mid[:2]).all()
    assert mid[2] == pytest.approx(10.0666667, abs=1e-6)
    assert upper[2] == pytest.approx(10.9046539, abs=1e-6)
    assert lower[2] == pytest.approx(9.2286795, abs=1e-6)
    # next window 10.5, 10.2, 11.8 : mean 10.8333333, sd 0.6944222
    assert mid[3] == pytest.approx(10.8333333, abs=1e-6)
    assert upper[3] - mid[3] == pytest.approx(2 * 0.6944222, abs=1e-6)


def test_donchian_excludes_current_candle():
    high = np.array([1.0, 5.0, 3.0, 4.0, 9.0])
    low = np.array([0.5, 2.0, 1.0, 3.0, 0.1])
    hi, lo = ind.donchian(high, low, 2)
    assert np.isnan(hi[:2]).all()
    assert hi[2:] == pytest.approx([5.0, 5.0, 4.0])   # the 9.0 of the current candle is never included
    assert lo[2:] == pytest.approx([0.5, 1.0, 1.0])


def test_indicators_are_causal():
    """A value at index i must not change when later candles are appended."""
    rng = np.random.default_rng(1)
    c = 100 + np.cumsum(rng.normal(0, 1, 300))
    h, l = c + rng.random(300), c - rng.random(300)
    for cut in (120, 250):
        assert np.allclose(ind.ema(c, 20)[:cut], ind.ema(c[:cut], 20), equal_nan=True)
        assert np.allclose(ind.atr(h, l, c, 14)[:cut], ind.atr(h[:cut], l[:cut], c[:cut], 14), equal_nan=True)
        assert np.allclose(ind.rsi(c, 14)[:cut], ind.rsi(c[:cut], 14), equal_nan=True)
        assert np.allclose(ind.adx(h, l, c, 14)[:cut], ind.adx(h[:cut], l[:cut], c[:cut], 14), equal_nan=True)
        for a, b in zip(ind.bollinger(c, 20, 2.0), ind.bollinger(c[:cut], 20, 2.0)):
            assert np.allclose(a[:cut], b, equal_nan=True)
