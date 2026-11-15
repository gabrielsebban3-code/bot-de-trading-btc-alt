"""Study 3 overlay: families F and G reuse the entries of B and C and only change the exit."""
import numpy as np
import pandas as pd
import yaml

from src import data, setups
from tests.conftest import random_funding, random_walk_df


def _cfg3():
    cfg = data.load_config()
    base_families = cfg["families"]
    cfg.update(yaml.safe_load((data.ROOT / "config" / "etude3.yaml").read_text()))
    return cfg, base_families


def test_overlay_changes_only_families():
    base = data.load_config()
    cfg, _ = _cfg3()
    assert set(cfg["families"]) == {"F", "G"}
    for key in base:
        if key != "families":
            assert cfg[key] == base[key]
    configs = setups.all_configs(cfg)
    assert len(configs) == 32 and len({c["config_id"] for c in configs}) == 32
    assert len(setups.all_configs(base)) == 100                      # study 1 grid untouched


def test_fixed_target_variants_share_entries_with_b_and_c():
    cfg, base_families = _cfg3()
    full = dict(cfg, families={**base_families, **cfg["families"]})
    start = data.to_ms("2021-01-01")
    df = random_walk_df(96 * 200, seed=7, start_ms=start)
    fd = random_funding(96 * 200, seed=7, start_ms=start)
    ctx = setups.SymbolContext("AAAUSDT", df, fd, full, warmup_ms=10 * 86_400_000)
    key = ["order_time", "direction", "stop_price", "stop_dist"]
    b = setups.signals_B(ctx, {"timeframe": "1h", "rsi_thresholds": "45/55", "stop": "atr", "exit": "tp2r"})
    f = setups.SIGNAL_FUNCS["F"](ctx, {"timeframe": "1h", "rsi_thresholds": "45/55", "stop": "atr", "tp_r": 1.5})
    assert len(b) > 5
    pd.testing.assert_frame_equal(b[key].reset_index(drop=True), f[key].reset_index(drop=True))
    assert (f["tp_r"] == 1.5).all() and f["trail_mult"].isna().all()
    c = setups.signals_C(ctx, {"timeframe": "1h", "donchian_n": 20, "volume_filter": "on"})
    g = setups.SIGNAL_FUNCS["G"](ctx, {"timeframe": "1h", "donchian_n": 20, "volume_filter": "on", "tp_r": 1.0})
    assert len(c) > 5
    pd.testing.assert_frame_equal(c[key].reset_index(drop=True), g[key].reset_index(drop=True))
    assert (g["tp_r"] == 1.0).all() and g["trail_mult"].isna().all() and c["trail_mult"].notna().all()
    spec = setups.exit_spec(full, {"family": "G", "params": {"timeframe": "1h", "tp_r": 1.0}})
    assert spec["tp_mode"] == "r" and spec["tp_r"] == 1.0 and spec["trail_mult"] is None
