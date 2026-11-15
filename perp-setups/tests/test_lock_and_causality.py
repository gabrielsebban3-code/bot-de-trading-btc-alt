"""TEST-set lock, absence of look-ahead in every setup family, reproducibility."""
import copy

import numpy as np
import pandas as pd
import pytest

from src import data, engine, setups
from tests.conftest import T0, make_symbol, random_funding, random_walk_df

BAR = data.BAR_MS


# ------------------------------------------------------------------ TEST set lock

@pytest.fixture()
def disk(tmp_path, monkeypatch, cfg):
    """A small parquet store straddling the DEV/VAL -> TEST boundary."""
    monkeypatch.setattr(data, "PARQUET_DIR", tmp_path)
    (tmp_path / "klines").mkdir()
    (tmp_path / "funding").mkdir()
    start = data.to_ms("2024-12-30")
    n = 6 * 96
    df = random_walk_df(n, seed=7, start_ms=start)
    out = df.copy()
    out["open_time"] = pd.to_datetime(out["open_time"], unit="ms", utc=True)
    out.to_parquet(tmp_path / "klines" / "LOCKUSDT.parquet", index=False)
    fd = pd.DataFrame({"funding_time": pd.to_datetime(np.arange(start, start + n * BAR, 8 * 3_600_000), unit="ms", utc=True),
                       "funding_rate": 0.0001})
    fd.to_parquet(tmp_path / "funding" / "LOCKUSDT.parquet", index=False)
    return cfg


def test_config_ships_locked(cfg):
    assert cfg["final_test_unlocked"] is False


def test_test_set_bounds_are_refused_while_locked(cfg):
    assert cfg["final_test_unlocked"] is False
    data.set_bounds_ms(cfg, "dev")
    data.set_bounds_ms(cfg, "val")
    with pytest.raises(data.TestSetLockedError):
        data.set_bounds_ms(cfg, "test")


def test_test_rows_are_never_loaded_while_locked(disk):
    cfg = disk
    limit = data.to_ms("2025-01-01")
    df = data.load_klines(cfg, "LOCKUSDT")
    assert len(df) == 2 * 96 and df["open_time"].max() < limit
    assert data.load_funding(cfg, "LOCKUSDT")["funding_time"].max() < limit
    with pytest.raises(data.TestSetLockedError):
        data.load_klines(cfg, "LOCKUSDT", end_ms=limit + BAR)
    with pytest.raises(data.TestSetLockedError):
        data.load_funding(cfg, "LOCKUSDT", end_ms=limit + BAR)


def test_test_rows_available_only_after_unlock(disk):
    cfg = copy.deepcopy(disk)
    cfg["final_test_unlocked"] = True
    cfg["data"]["end_month"] = "2025-01"
    assert len(data.load_klines(cfg, "LOCKUSDT")) == 6 * 96
    start, end = data.set_bounds_ms(cfg, "test")
    assert start == data.to_ms("2025-01-01") and end == data.to_ms("2025-02-01")


def test_cli_backtest_refuses_test_set_while_locked(cfg):
    from src import run
    with pytest.raises(data.TestSetLockedError):
        run.check_sets_allowed(cfg, ["dev", "test"])


# ------------------------------------------------------------------ no look-ahead in the setups

N_BARS = 14_000
CUTS = (9_000, 12_345)


@pytest.fixture(scope="module")
def walk():
    cfg = data.load_config()
    df = random_walk_df(N_BARS, seed=11)
    fund = random_funding(N_BARS, seed=11)
    return cfg, df, fund


def _configs_by_family(cfg):
    out = {}
    for c in setups.all_configs(cfg):
        out.setdefault(c["family"], []).append(c)
    return out


@pytest.mark.parametrize("family", ["A", "B", "C", "D", "E"])
def test_signals_do_not_depend_on_future_candles(walk, family):
    """Signals computed on a truncated history equal the same-period signals computed on the full history.

    This proves at once: no look-ahead, pivots confirmed with delay, higher timeframe used after its
    close only, and no repainting (a signal never changes or disappears when new candles arrive).
    """
    cfg, df, fund = walk
    ctx_full, _ = make_symbol(df, cfg, fund)
    total = 0
    for config in _configs_by_family(cfg)[family]:
        full = setups.generate_signals(ctx_full, config)
        for cut in CUTS:
            df_cut = df.iloc[:cut].reset_index(drop=True)
            cut_ms = int(df_cut["open_time"].iloc[-1]) + BAR          # first instant after the truncated history
            fund_cut = fund[fund["funding_time"] < cut_ms].reset_index(drop=True)
            ctx_cut, _ = make_symbol(df_cut, cfg, fund_cut)
            part = setups.generate_signals(ctx_cut, config)
            expected = full[full["order_time"] <= cut_ms].reset_index(drop=True)
            pd.testing.assert_frame_equal(part, expected, check_dtype=False)
            total += len(part)
    assert total > 0, "the synthetic series produced no signal: the test would be empty"


def test_every_family_fires_on_the_synthetic_series(walk):
    cfg, df, fund = walk
    ctx, _ = make_symbol(df, cfg, fund)
    counts = {}
    for config in setups.all_configs(cfg):
        counts[config["family"]] = counts.get(config["family"], 0) + len(setups.generate_signals(ctx, config))
    assert all(v > 0 for v in counts.values()), counts


def test_signal_time_is_the_close_of_a_candle_already_available(walk):
    cfg, df, fund = walk
    ctx, _ = make_symbol(df, cfg, fund)
    for config in setups.all_configs(cfg)[::7]:
        sig = setups.generate_signals(ctx, config)
        tf = setups.timeframe_of(cfg, config)
        closes = set(ctx.bars[tf].ct.tolist())
        assert set(sig["order_time"].tolist()) <= closes


def test_grid_has_exactly_100_configurations(cfg):
    configs = setups.all_configs(cfg)
    by_family = {}
    for c in configs:
        by_family[c["family"]] = by_family.get(c["family"], 0) + 1
    assert by_family == {"A": 64, "B": 16, "C": 8, "D": 8, "E": 4}
    assert len({c["config_id"] for c in configs}) == 100
    # direct neighbours differ by exactly one parameter
    assert len(setups.neighbours(configs[0], configs)) == 6
    assert len(setups.neighbours(configs[-1], configs)) == 2


def test_warmup_blocks_early_signals(walk):
    cfg, df, fund = walk
    warm = 30 * 86_400_000
    ctx, _ = make_symbol(df, cfg, fund, warmup_ms=warm)
    for config in setups.all_configs(cfg)[::9]:
        sig = setups.generate_signals(ctx, config)
        if len(sig):
            assert sig["order_time"].min() >= int(df["open_time"].iloc[0]) + warm


def test_signals_blocked_after_a_data_gap(walk):
    cfg, df, fund = walk
    holed = df.drop(index=range(7000, 7003)).reset_index(drop=True)
    warm = 10 * 86_400_000
    ctx, _ = make_symbol(holed, cfg, fund, warmup_ms=warm)
    gap_end = int(df["open_time"].iloc[7003])
    for config in setups.all_configs(cfg)[::5]:
        sig = setups.generate_signals(ctx, config)
        tf_ms = data.TF_MS[setups.timeframe_of(cfg, config)]
        inside = sig[(sig["order_time"] > gap_end) & (sig["order_time"] < gap_end + warm)]
        assert len(inside) == 0, config["config_id"]
        assert tf_ms > 0


# ------------------------------------------------------------------ reproducibility

def _full_run(cfg, df, fund, config):
    ctx, sd = make_symbol(df, cfg, fund)
    sig = setups.generate_signals(ctx, config)
    start, end = int(df["open_time"].iloc[0]), int(df["open_time"].iloc[-1]) + BAR
    trades, info = engine.run_backtest(sig, {"TESTUSDT": sd}, cfg, start, end, config["family"], config["config_id"])
    return trades, info, ctx, sd


def test_two_runs_give_strictly_identical_trades(walk):
    cfg, df, fund = walk
    configs = setups.all_configs(cfg)
    n_trades = 0
    for config in (configs[8], configs[66], configs[81], configs[88], configs[96]):
        a, _, _, _ = _full_run(cfg, df, fund, config)
        b, _, _, _ = _full_run(cfg, df, fund, config)
        pd.testing.assert_frame_equal(a, b)
        assert a.to_csv(index=False) == b.to_csv(index=False)
        n_trades += len(a)
    assert n_trades > 0


def test_baseline_is_reproducible_with_the_fixed_seed(walk):
    from src import run
    cfg, df, fund = walk
    config = setups.all_configs(cfg)[66]
    trades, info, ctx, sd = _full_run(cfg, df, fund, config)
    assert len(trades) > 5
    start, end = int(df["open_time"].iloc[0]), int(df["open_time"].iloc[-1]) + BAR
    kw = dict(market={"TESTUSDT": sd}, ctxs={"TESTUSDT": ctx}, cfg=cfg, config=config, trades=trades, info=info,
              start_ms=start, end_ms=end, pool_size=300, n_sims=200)
    one = run.baseline_distribution(**kw)
    two = run.baseline_distribution(**kw)
    assert np.array_equal(one, two) and len(one) == 200
