"""Rule 1 (mandatory test): what is known on the first N candles never depends on the following candles.

For every detector: outputs computed on the first N candles == outputs computed on the full history and
restricted to items confirmed before N. Also: randomly changing every candle after N changes nothing before N.
"""
import numpy as np
import pandas as pd
import pytest

from bot.indicators.volatility import atr
from bot.structure.liquidity import equal_levels, sweeps
from bot.structure.market_structure import structure_events
from bot.structure.pivots import fractal_pivots, hierarchical_pivots, zigzag_pivots
from bot.structure.zones import fvgs, order_blocks
from bot.tests.conftest import make_bars, random_walk


def detectors(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    a = atr(h, l, c, 14)
    out = {
        "fractal": fractal_pivots(h, l, 3),
        "zigzag": zigzag_pivots(h, l, a, 3.0),
        "hier": hierarchical_pivots(h, l, 2, 2, 2),
    }
    ev, trend = structure_events(c, out["fractal"])
    out["events"] = ev
    out["trend"] = pd.DataFrame({"confirm_idx": np.arange(len(c)), "trend": trend})
    out["fvg"] = fvgs(h, l)
    out["ob"] = order_blocks(o, h, l, c, out["fvg"], ev)
    lv = equal_levels(out["fractal"], 0.002, 100)
    out["sweeps"] = sweeps(h, l, c, lv, "eq")
    return out


def _known_before(df: pd.DataFrame, n: int) -> pd.DataFrame:
    col = "confirm_idx" if "confirm_idx" in df.columns else "idx"
    d = df[df[col] < n].copy()
    return d.sort_values(list(d.columns), kind="stable").reset_index(drop=True)


@pytest.mark.parametrize("seed,cut", [(1, 300), (2, 451), (3, 777), (4, 999)])
def test_prefix_equals_truncated_full(seed, cut):
    df = make_bars(random_walk(1500, seed=seed, vol=0.012))
    full = detectors(df)
    part = detectors(df.iloc[:cut].reset_index(drop=True))
    for name in full:
        pd.testing.assert_frame_equal(_known_before(full[name], cut), _known_before(part[name], cut),
                                      check_dtype=False, obj=name)


@pytest.mark.parametrize("seed,cut", [(5, 500), (6, 800)])
def test_future_perturbation_changes_nothing_before_cut(seed, cut):
    df = make_bars(random_walk(1200, seed=seed, vol=0.012))
    alt = df.copy()
    rng = np.random.default_rng(seed + 100)
    noise = random_walk(len(df) - cut, seed=seed + 200, start=float(df["close"].iloc[cut - 1]), vol=0.03)
    alt2 = make_bars(np.concatenate([df["close"].to_numpy()[:cut], noise]))
    a, b = detectors(df), detectors(alt2)
    for name in a:
        pd.testing.assert_frame_equal(_known_before(a[name], cut), _known_before(b[name], cut),
                                      check_dtype=False, obj=name)
