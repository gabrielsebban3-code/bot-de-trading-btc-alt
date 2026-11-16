"""Study 5: the model only ever sees what was known at the time (features, labels, thresholds)."""
import numpy as np
import pandas as pd
import pytest
import yaml

from src import data, engine, etude5, setups
from tests.conftest import make_symbol, random_funding, random_walk_df

BAR = data.BAR_MS
PARAMS = {"max_depth": 2, "max_iter": 20, "learning_rate": 0.1, "min_samples_leaf": 20, "l2_regularization": 1.0}


@pytest.fixture(scope="module")
def world():
    cfg = data.load_config()
    cfg.update(yaml.safe_load((data.ROOT / "config" / "etude5.yaml").read_text()))
    n = 20_000
    df, fund = random_walk_df(n, seed=5), random_funding(n, seed=5)
    btc = random_walk_df(n, seed=6)
    return cfg, df, fund, btc


def test_overlay_has_one_candidate_configuration(world):
    cfg = world[0]
    ids = [c["config_id"] for c in setups.all_configs(cfg)]
    assert ids == [cfg["etude5"]["candidates"]] == ["M7_tf1h_v2_tp2p5"] and cfg["final_test_unlocked"] is False


def test_features_do_not_depend_on_future_candles(world):
    cfg, df, fund, btc = world
    config = setups.all_configs(cfg)[0]
    ctx, _ = make_symbol(df, cfg, fund)
    ctx_btc, _ = make_symbol(btc, cfg, None, symbol="BTCUSDT")
    sig = setups.generate_signals(ctx, config)
    full = etude5.features_for(ctx, ctx_btc, sig, cfg)
    assert len(sig) > 50 and list(full.columns) == etude5.FEATURES and full.notna().mean().min() > 0.5
    for cut in (9_000, 15_123):
        cut_ms = int(df["open_time"].iloc[cut - 1]) + BAR
        c2, _ = make_symbol(df.iloc[:cut].reset_index(drop=True), cfg, fund[fund["funding_time"] < cut_ms].reset_index(drop=True))
        b2, _ = make_symbol(btc.iloc[:cut].reset_index(drop=True), cfg, None, symbol="BTCUSDT")
        sig2 = setups.generate_signals(c2, config)
        part = etude5.features_for(c2, b2, sig2, cfg)
        pd.testing.assert_frame_equal(part, full.iloc[:len(sig2)].reset_index(drop=True), check_exact=False, rtol=1e-9)


def _cands(n=6000, seed=0):
    rng = np.random.default_rng(seed)
    t0 = data.to_ms("2021-01-01")
    t = np.sort(t0 + rng.integers(0, 20 * 30 * 86_400_000, n))
    X = rng.normal(size=(n, len(etude5.FEATURES)))
    r = np.where(X[:, 0] + rng.normal(size=n) > 0, 2.4, -1.1)
    c = pd.DataFrame(X, columns=etude5.FEATURES)
    c["order_time"], c["exit_ms"], c["r"] = t, t + rng.integers(1, 72, n) * 3_600_000, r
    return c


def test_scores_use_only_trades_closed_before_the_month():
    c = _cands()
    s1 = etude5.oos_scores(c, PARAMS, 12, 42)
    assert np.isnan(s1[c["order_time"] < data.to_ms("2022-01-01")]).all() and np.isfinite(s1).sum() > 500
    month = data.to_ms("2022-03-01")
    c2 = c.copy()
    later = c2["exit_ms"] >= month                       # anything not yet closed on March 1st is rewritten
    c2.loc[later, "r"] = -c2.loc[later, "r"]
    after = c2["order_time"] >= data.to_ms("2022-04-01")
    c2.loc[after, etude5.FEATURES] = 0.0
    s2 = etude5.oos_scores(c2, PARAMS, 12, 42)
    in_march = (c["order_time"] >= month) & (c["order_time"] < data.to_ms("2022-04-01"))
    np.testing.assert_array_equal(s1[in_march], s2[in_march])
    np.testing.assert_array_equal(s1, etude5.oos_scores(c, PARAMS, 12, 42))        # reproducible


def test_threshold_uses_only_previous_months():
    c = _cands()
    c["score"] = etude5.oos_scores(c, PARAMS, 12, 42)
    k1 = etude5.keep_mask(c, 0.6, 6)
    first = c.loc[k1, "order_time"].min()
    assert first >= data.to_ms("2022-07-01")             # 12 months of history + 6 months of out-of-sample scores
    c2 = c.copy()
    c2.loc[c2["order_time"] >= data.to_ms("2022-09-01"), "score"] = 0.99
    k2 = etude5.keep_mask(c2, 0.6, 6)
    before = (c["order_time"] < data.to_ms("2022-09-01")).to_numpy()
    np.testing.assert_array_equal(k1[before], k2[before])
    share = k1[(c["order_time"] >= data.to_ms("2022-07-01")).to_numpy()].mean()
    assert 0.25 < share < 0.55                           # keeps roughly the best 40 %


def test_standalone_outcome_matches_a_single_engine_run(world):
    cfg, df, fund, _ = world
    config = setups.all_configs(cfg)[0]
    ctx, sd = make_symbol(df, cfg, fund)
    sig = setups.generate_signals(ctx, config).iloc[:40].reset_index(drop=True)
    end = int(df["open_time"].iloc[-1]) + BAR
    out = etude5.standalone_outcomes(sig, {"TESTUSDT": sd}, cfg, end)
    assert len(out) > 20
    i = out.index[3]
    tr, _ = engine.run_backtest(sig.iloc[i:i + 1], {"TESTUSDT": sd}, cfg, int(sig["order_time"].iloc[i]), end, "M7", "x")
    assert out.loc[i, "r"] == pytest.approx(float(tr["r_multiple_net"].iloc[0])) and out.loc[i, "exit_ms"] > sig["order_time"].iloc[i]
