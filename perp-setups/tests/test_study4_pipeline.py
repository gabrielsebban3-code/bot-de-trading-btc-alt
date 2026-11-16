"""Study 4 pipeline on synthetic candles: selection on training, criteria, stability, locked final test."""
import copy
import json

import pandas as pd
import pytest
import yaml

from src import data, etude4, run
from tests.conftest import random_funding, random_walk_df

SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT"]


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    cfg = data.load_config()
    cfg.update(yaml.safe_load((data.ROOT / "config" / "etude4.yaml").read_text()))
    cfg["data"].update(start="2024-08-01", warmup_days=10, end_month="2025-02")
    cfg["sets"] = {"dev": {"start": "2024-08-01", "end": "2024-10-31"}, "val": {"start": "2024-11-01", "end": "2024-12-31"},
                   "test": {"start": "2025-01-01", "end": None}}
    cfg["stats"].update(bootstrap_resamples=200, baseline_simulations=50, baseline_pool_min=60,
                        baseline_pool_per_trade=1, baseline_pool_max=60)
    cfg["etude4"]["train_min_trades"] = 5
    cfg["etude4"]["criteria"]["monte_carlo_resamples"] = 200
    cfg["etude4"]["walk_forward"] = [{"start": "2024-10-01", "end": "2024-10-31"}, {"start": "2024-11-01", "end": "2024-12-31"}]
    state = {"cfg": cfg}

    def fake_setup():
        return copy.deepcopy(state["cfg"])

    monkeypatch.setattr(etude4, "setup", fake_setup)
    monkeypatch.setattr(data, "load_config", lambda path=None: copy.deepcopy(state["cfg"]))
    monkeypatch.setattr(data, "PARQUET_DIR", tmp_path / "parquet")
    monkeypatch.setattr(data, "PAIRS_PATH", tmp_path / "pairs.json")
    monkeypatch.setattr(run, "RESULTS", tmp_path / "results")
    monkeypatch.setattr(run, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(run, "LOG_PATH", tmp_path / "results" / "run_log.txt")
    monkeypatch.setattr(run, "TRIALS_PATH", tmp_path / "TRIALS_etude4.csv")
    (tmp_path / "parquet" / "klines").mkdir(parents=True)
    (tmp_path / "parquet" / "funding").mkdir(parents=True)
    (tmp_path / "results").mkdir()
    start = data.to_ms("2024-08-01")
    n = 212 * 96
    pairs = []
    for i, sym in enumerate(SYMBOLS):
        df, fd = random_walk_df(n, seed=200 + i, start_ms=start), random_funding(n, seed=200 + i, start_ms=start)
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        fd["funding_time"] = pd.to_datetime(fd["funding_time"], unit="ms", utc=True)
        df.to_parquet(tmp_path / "parquet" / "klines" / f"{sym}.parquet", index=False)
        fd.to_parquet(tmp_path / "parquet" / "funding" / f"{sym}.parquet", index=False)
        pairs.append({"symbol": sym, "onboardDate": start, "onboardDateUTC": "2024-08-01 00:00:00+00:00",
                      "avg_daily_quote_volume_90d": 1.0e9})
    (tmp_path / "pairs.json").write_text(json.dumps({"pairs": pairs}))
    return tmp_path, state


def test_study4_run_selection_and_locked_test(sandbox, monkeypatch):
    tmp, state = sandbox
    res = tmp / "results"
    etude4.main(["run", "--workers", "1"])
    dev, val = pd.read_csv(res / "summary_dev.csv"), pd.read_csv(res / "summary_val.csv")
    assert len(dev) == len(val) == 56
    sel = json.loads((res / "selection.json").read_text())
    assert set(sel["methods"]) == {f"M{i}" for i in range(1, 8)} and sel["n_variants"] == 56
    d = dev.set_index("config_id")
    for fam, e in sel["methods"].items():
        if e["selected"]:                                   # best training expectancy among variants with enough trades
            ok = dev[(dev["family"] == fam) & (dev["n_trades"] >= 5)]
            assert d.loc[e["selected"], "expectancy_r"] == ok["expectancy_r"].max()
            assert set(etude4.CRITERIA) <= set(e["validation"])
            assert e["validation"]["all_passed"] == all(e["validation"][c] for c in etude4.CRITERIA)
    wf = pd.read_csv(res / "walkforward.csv")
    assert len(wf) == 14 and set(wf["window"]) == {1, 2}
    limit = pd.Timestamp("2025-01-01", tz="UTC")
    for p in res.glob("trades_*.csv"):                      # nothing from the final-test period
        t = pd.read_csv(p, parse_dates=["exit_time"])
        assert (t["exit_time"] < limit).all()
    with pytest.raises(data.TestSetLockedError):
        etude4.main(["test", "--workers", "1"])
    assert "final_test_unlocked=False" in (res / "run_log.txt").read_text()

    # force every method through: stability is computed, the three best go to the final test, once
    real = etude4.assess

    def lenient(*a, **k):
        out = real(*a, **k)
        out.update({c: True for c in etude4.CRITERIA}, criteria_failed="", all_passed=True)
        return out

    monkeypatch.setattr(etude4, "assess", lenient)
    for p in list(res.glob("*")):
        p.unlink()
    etude4.main(["run", "--workers", "2"])
    sel = json.loads((res / "selection.json").read_text())
    chosen = [e for e in sel["methods"].values() if e["selected"]]
    assert all(len(e["stability"]["variants"]) == 6 for e in chosen)
    assert sel["n_shifted_variants"] == 6 * len(chosen) and len(sel["finalists"]) <= 3
    stable = [e["selected"] for e in chosen if e["stability"]["passed"]]
    assert set(sel["finalists"]) <= set(stable)
    trials = pd.read_csv(tmp / "TRIALS_etude4.csv")
    assert trials["config_id"].nunique() == 56 + sel["n_shifted_variants"]
    if sel["finalists"]:
        state["cfg"]["final_test_unlocked"] = True
        etude4.main(["test", "--workers", "1"])
        test = pd.read_csv(res / "summary_test.csv")
        assert set(test["config_id"]) == set(sel["finalists"])
        final = json.loads((res / "selection.json").read_text())
        assert set(final["retained"]) == set(sel["finalists"])          # lenient criteria: all retained
        with pytest.raises(RuntimeError):
            etude4.main(["test", "--workers", "1"])
