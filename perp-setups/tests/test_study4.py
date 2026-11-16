"""Study 4: the seven methods (families M1 to M7) read closed candles only and follow their written rules."""
import numpy as np
import pandas as pd
import pytest
import yaml

from src import data, methods, setups
from tests.conftest import T0, make_df, make_symbol, random_funding, random_walk_df

BAR = data.BAR_MS
N_BARS = 14_000
CUTS = (9_000, 12_345)


def _cfg4():
    cfg = data.load_config()
    base = dict(cfg)
    cfg.update(yaml.safe_load((data.ROOT / "config" / "etude4.yaml").read_text()))
    return cfg, base


@pytest.fixture(scope="module")
def walk():
    cfg, _ = _cfg4()
    return cfg, random_walk_df(N_BARS, seed=11), random_funding(N_BARS, seed=11)


def test_overlay_grid_and_untouched_blocks():
    cfg, base = _cfg4()
    configs = setups.all_configs(cfg)
    assert len(configs) == 56 and len({c["config_id"] for c in configs}) == 56
    assert sorted({c["family"] for c in configs}) == [f"M{i}" for i in range(1, 8)]
    assert all(sum(1 for c in configs if c["family"] == f"M{i}") == 8 for i in range(1, 8))
    assert cfg["final_test_unlocked"] is False
    for key in ("data", "indicators", "stats", "seed"):
        assert cfg[key] == base[key]
    assert cfg["costs"]["maker_fee"] == cfg["costs"]["taker_fee"] == 0.0005 and cfg["costs"]["slippage"] == 0.0002
    b = [data.to_ms(cfg["sets"][s]["start"]) for s in ("dev", "val", "test")]
    total = data.data_end_ms(cfg) - b[0]
    assert abs((b[1] - b[0]) / total - 0.60) < 0.01 and abs((b[2] - b[1]) / total - 0.20) < 0.01


@pytest.mark.parametrize("family", [f"M{i}" for i in range(1, 8)])
def test_signals_do_not_depend_on_future_candles(walk, family):
    cfg, df, fund = walk
    ctx_full, _ = make_symbol(df, cfg, fund)
    total = 0
    for config in [c for c in setups.all_configs(cfg) if c["family"] == family]:
        full = setups.generate_signals(ctx_full, config)
        tf = setups.timeframe_of(cfg, config)
        assert set(full["order_time"].tolist()) <= set(ctx_full.bars[tf].ct.tolist())
        for cut in CUTS:
            df_cut = df.iloc[:cut].reset_index(drop=True)
            cut_ms = int(df_cut["open_time"].iloc[-1]) + BAR
            ctx_cut, _ = make_symbol(df_cut, cfg, fund[fund["funding_time"] < cut_ms].reset_index(drop=True))
            part = setups.generate_signals(ctx_cut, config)
            expected = full[full["order_time"] <= cut_ms].reset_index(drop=True)
            pd.testing.assert_frame_equal(part, expected, check_dtype=False)
            total += len(part)
    assert total > 0, "the synthetic series produced no signal: the test would be empty"


def test_stop_and_target_come_from_the_atr(walk):
    cfg, df, fund = walk
    ctx, _ = make_symbol(df, cfg, fund)
    sig = setups.generate_signals(ctx, {"family": "M2", "params": {"timeframe": "1h", "donchian_n": 20, "tp_r": 2.5}})
    assert len(sig) > 5 and (sig["tp_r"] == 2.5).all() and (sig["order_type"] == "market").all()
    np.testing.assert_allclose(sig["stop_dist"], 1.5 * sig["atr"])
    wide = setups.generate_signals(ctx, {"family": "M2", "params": {"timeframe": "1h", "donchian_n": 20, "tp_r": 2.5, "sl_atr": 1.8}})
    np.testing.assert_allclose(wide["stop_dist"], 1.8 * wide["atr"])
    assert setups.exit_spec(cfg, {"family": "M2", "params": {"timeframe": "1h", "tp_r": 2.5}})["tp_r"] == 2.5


def test_smc_long_sequence_and_invalidation():
    # 25 quiet candles around 100, then: sweep of the lows, down candle (order block), up candle leaving a
    # fair value gap, a candle confirming the gap, and a retest closing up above the middle of the gap.
    base = [(100.0, 100.5, 99.5, 100.0)] * 25
    seq = [(100.0, 100.2, 99.0, 99.9),      # 25 sweep: low under 99.5, close back above
           (99.9, 100.1, 99.6, 99.7),       # 26 down candle = order block (low 99.6)
           (99.7, 101.5, 99.7, 101.4),      # 27 up candle creating the gap
           (101.4, 102.0, 100.6, 101.8),    # 28 low 100.6 > high[26] 100.1 -> gap [100.1, 100.6], middle 100.35
           (101.8, 101.9, 100.5, 101.0),    # 29 back inside the gap but closes down: no signal
           (101.0, 101.6, 100.4, 101.5)]    # 30 inside the gap, closes up above 100.35: signal
    o, h, l, c = (np.array(x, dtype="float64") for x in zip(*(base + seq)))
    out = methods._smc_long(o, h, l, c, 20, 5, 10, 10)
    assert np.nonzero(out)[0].tolist() == [30]
    seq2 = seq[:4] + [(101.8, 101.9, 99.0, 99.2)] + [seq[5]]     # 29 closes under the order block low
    o, h, l, c = (np.array(x, dtype="float64") for x in zip(*(base + seq2)))
    assert not methods._smc_long(o, h, l, c, 20, 5, 10, 10).any()


def test_vwap_restarts_every_utc_day():
    day0 = (T0 // 86_400_000 + 1) * 86_400_000
    ot = day0 + np.arange(8, dtype="int64") * 3_600_000 * 6          # four candles per day, two days
    c = np.array([10.0, 12.0, 11.0, 13.0, 20.0, 22.0, 24.0, 26.0])
    v = np.array([1.0, 3.0, 2.0, 2.0, 5.0, 1.0, 1.0, 1.0])
    vwap, sd, since, day = methods.session_vwap(ot, c, c, c, v)
    np.testing.assert_allclose(vwap[:4], np.cumsum(c[:4] * v[:4]) / np.cumsum(v[:4]))
    np.testing.assert_allclose(vwap[4], 20.0)                         # new session: the first candle alone
    np.testing.assert_allclose(vwap[7], np.sum(c[4:] * v[4:]) / np.sum(v[4:]))
    m = np.sum(c[:4] * v[:4]) / np.sum(v[:4])
    np.testing.assert_allclose(sd[3], np.sqrt(np.sum(v[:4] * (c[:4] - m) ** 2) / np.sum(v[:4])))
    assert since.tolist() == [0, 21_600_000, 43_200_000, 64_800_000] * 2 and day[0] != day[4]


def test_momentum_breaks_the_spike_candle_within_three_candles():
    cfg, _ = _cfg4()
    bars = [(100.0, 100.5, 99.5, 100.0)] * 30 + [(100.0, 101.0, 99.8, 100.9),      # 30 volume spike
                                                 (100.9, 101.0, 100.4, 100.6),     # 31 inside
                                                 (100.6, 101.6, 100.5, 101.5),     # 32 closes above 101.0: buy
                                                 (101.5, 102.5, 101.4, 102.4)] + [(102.4, 102.6, 102.2, 102.4)] * 5
    df = make_df(bars)
    df.loc[30, "volume"] = 500.0
    ctx, _ = make_symbol(df, cfg, None)
    sig = setups.generate_signals(ctx, {"family": "M7", "params": {"timeframe": "15m", "vol_mult": 3, "tp_r": 1.5}})
    assert sig["order_time"].tolist() == [int(df["open_time"].iloc[32]) + BAR] and sig["direction"].tolist() == [1]


def test_funding_signal_is_the_first_candle_opened_after_the_settlement(walk):
    cfg, df, fund = walk
    ctx, _ = make_symbol(df, cfg, fund)
    sig = setups.generate_signals(ctx, {"family": "M6", "params": {"timeframe": "1h", "z": 3, "tp_r": 1.5}})
    z = setups.funding_zscore(ctx.f_rate, 90)
    assert len(sig) > 0
    for t, d in zip(sig["order_time"], sig["direction"]):
        s = int(np.searchsorted(ctx.f_time, t - 3_600_000, side="left"))     # settlement inside the signal candle
        assert t - 2 * 3_600_000 < ctx.f_time[s] <= t - 3_600_000 and abs(z[s]) >= 3 and d == -np.sign(z[s])


def test_study6_grid_and_trailing_exit(walk):
    _, df, fund = walk
    cfg = data.load_config()
    cfg.update(yaml.safe_load((data.ROOT / "config" / "etude6.yaml").read_text()))
    e4, _ = _cfg4()
    assert cfg["costs"] == e4["costs"] and cfg["engine"] == e4["engine"] and cfg["sets"] == e4["sets"]
    assert cfg["etude4"] == e4["etude4"]
    configs = setups.all_configs(cfg)
    assert len(configs) == 8 and {c["family"] for c in configs} == {"M7"}
    ctx, _ = make_symbol(df, cfg, fund)
    by_id = {c["config_id"]: c for c in configs}
    tp = setups.generate_signals(ctx, by_id["M7_tf1h_v3_exittp"])
    tr = setups.generate_signals(ctx, by_id["M7_tf1h_v3_exittrail"])
    old = setups.generate_signals(ctx, {"family": "M7", "params": {"timeframe": "1h", "vol_mult": 3, "tp_r": 2.5}})
    pd.testing.assert_frame_equal(tp, old)                                   # same as the study 4 variant
    assert len(tr) == len(tp) > 5 and (tr["trail_mult"] == 3.0).all() and tr["tp_r"].isna().all()
    assert setups.exit_spec(cfg, by_id["M7_tf4h_v4_exittrail"])["trail_mult"] == 3.0
    assert setups.exit_spec(cfg, by_id["M7_tf4h_v4_exittp"])["tp_r"] == 2.5
    from src import etude4
    shifted = etude4.shifted_configs(cfg, by_id["M7_tf4h_v4_exittrail"], 8)
    assert [c["shifted"] for c in shifted] == ["vol_mult"] * 2 + ["sl_atr"] * 2 + ["trail_atr"] * 2
    assert sorted(c["params"]["trail_atr"] for c in shifted if c["shifted"] == "trail_atr") == [2.4, 3.6]
