import numpy as np
import pandas as pd

from bot.structure.liquidity import equal_levels, sweeps
from bot.structure.market_structure import label_pivots, structure_events
from bot.structure.pivots import add_amplitude, fractal_pivots, hierarchical_pivots, zigzag_pivots
from bot.structure.zones import fvgs, order_blocks


def _rows(df, cols=("idx", "confirm_idx", "price", "kind")):
    return [tuple(r) for r in df[list(cols)].itertuples(index=False)]


def test_fractal_known_pivots():
    h = np.array([1, 2, 5, 2, 1, 2, 3, 4, 3, 2], dtype=float)
    l = np.array([5, 4, 1, 4, 5, 4, 3, 0.5, 3, 4], dtype=float)
    p = fractal_pivots(h, l, 2)
    assert sorted(_rows(p)) == sorted([(2, 4, 5.0, 1), (7, 9, 4.0, 1), (2, 4, 1.0, -1), (7, 9, 0.5, -1)])


def test_fractal_ties_first_candle_wins():
    h = np.array([1, 3, 3, 1, 1], dtype=float)
    p = fractal_pivots(h, np.full(5, 0.5) + np.arange(5), 1)
    assert [r for r in _rows(p) if r[3] == 1] == [(1, 2, 3.0, 1)]


def test_zigzag_known_pivots():
    px = np.array([10, 12, 14, 16, 18, 20, 19, 18, 17, 16, 15, 17, 19, 21, 23, 25, 24, 23, 22, 21], dtype=float)
    p = zigzag_pivots(px, px, np.ones(len(px)), 3.0)
    assert _rows(p) == [(0, 2, 10.0, -1), (5, 8, 20.0, 1), (10, 12, 15.0, -1), (15, 18, 25.0, 1)]


def test_zigzag_new_extreme_cannot_confirm_itself():
    # candle 2 makes a new high AND a low 3 ATR below it: the order inside the candle is unknown
    h = np.array([10, 11, 15, 12], dtype=float)
    l = np.array([10, 11, 8, 12], dtype=float)
    p = zigzag_pivots(h, l, np.ones(4), 3.0)
    assert (p["confirm_idx"] != 2).all() or not ((p["idx"] == 2) & (p["kind"] == 1)).any()


def test_hierarchical_levels():
    h = np.array([0, 3, 0, 5, 0, 9, 0, 6, 0, 4, 0], dtype=float)
    p = hierarchical_pivots(h, h, minor_n=1, intermediate_n=1, major_n=1)
    minor_highs = p[(p["level"] == "minor") & (p["kind"] == 1)]
    assert minor_highs["idx"].tolist() == [1, 3, 5, 7, 9]
    inter = p[(p["level"] == "intermediate") & (p["kind"] == 1)]
    assert _rows(inter) == [(5, 8, 9.0, 1)]          # confirmed only when the next minor high (idx 7) is confirmed


def test_amplitude_in_atr():
    piv = pd.DataFrame({"idx": [1, 3], "confirm_idx": [2, 4], "price": [10.0, 4.0], "kind": [1, -1],
                        "level": ["fractal"] * 2})
    out = add_amplitude(piv, np.full(5, 2.0))
    assert np.isnan(out["amplitude_atr"][0]) and out["amplitude_atr"][1] == 3.0


def test_labels_and_bos_choch_without_lookahead():
    piv = pd.DataFrame({"idx": [2, 5], "confirm_idx": [4, 7], "price": [10.0, 5.0], "kind": [1, -1],
                        "level": ["fractal"] * 2})
    # close[3] = 12 is above the high, but the high is only known at t = 4: no break at t = 3
    close = np.array([8, 9, 10, 12, 8, 6, 5, 6, 7, 9, 11, 6, 4], dtype=float)
    ev, trend = structure_events(close, piv)
    assert [tuple(r) for r in ev[["idx", "kind", "direction", "level", "pivot_idx"]].itertuples(index=False)] == \
        [(10, "BOS", 1, 10.0, 2), (12, "CHoCH", -1, 5.0, 5)]
    assert trend[9] == 0 and trend[10] == 1 and trend[12] == -1


def test_label_hh_hl():
    piv = pd.DataFrame({"idx": [1, 3, 5, 7], "confirm_idx": [2, 4, 6, 8], "price": [10.0, 5.0, 12.0, 4.0],
                        "kind": [1, -1, 1, -1], "level": ["fractal"] * 4})
    assert label_pivots(piv).tolist() == ["", "", "HH", "LL"]


def test_fvg_confirmed_at_third_candle():
    h = np.array([10, 12, 13], dtype=float)
    l = np.array([9, 10, 11], dtype=float)
    z = fvgs(h, l)
    assert z.to_dict("records") == [{"confirm_idx": 2, "direction": 1, "bottom": 10.0, "top": 11.0,
                                     "origin_idx": 1, "kind": "FVG"}]


def test_order_block_requires_displacement_and_break():
    o = np.array([10.0, 9.4, 10.5, 12.5])
    c = np.array([9.2, 10.4, 12.4, 13.0])
    h = np.array([10.1, 10.5, 12.6, 13.2])
    l = np.array([9.1, 9.3, 10.4, 12.4])
    z = fvgs(h, l)                                     # bullish FVG on (1, 2, 3): l[3]=12.4 > h[1]=10.5
    assert (z["direction"] == 1).any()
    ev = pd.DataFrame({"idx": [3], "kind": ["BOS"], "direction": [1], "level": [12.0], "pivot_idx": [0]})
    ob = order_blocks(o, h, l, c, z, ev)
    assert ob[["confirm_idx", "direction", "origin_idx"]].values.tolist() == [[3, 1, 0]]
    no_break = order_blocks(o, h, l, c, z, ev.iloc[0:0])
    assert no_break.empty


def test_equal_highs_and_sweep():
    piv = pd.DataFrame({"idx": [1, 4], "confirm_idx": [3, 6], "price": [100.0, 100.1], "kind": [1, 1],
                        "level": ["fractal"] * 2})
    lv = equal_levels(piv, 0.0015, lookback=50)
    assert lv.values.tolist() == [[6, 1, 100.1]]
    h = np.array([0, 0, 0, 0, 0, 0, 0, 100.0, 100.5], dtype=float)
    c = np.array([0, 0, 0, 0, 0, 0, 0, 99.0, 99.8], dtype=float)
    sw = sweeps(h, np.zeros(9), c, lv, "equal_highs")
    assert sw.values.tolist() == [[8, -1, 100.1, "equal_highs"]]
    c2 = c.copy()
    c2[8] = 100.3                                       # closes beyond: a breakout, not a sweep
    assert sweeps(h, np.zeros(9), c2, lv, "equal_highs").empty
