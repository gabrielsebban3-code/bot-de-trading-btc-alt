"""End-to-end pipeline on synthetic candles: DEV -> selection -> VAL, TEST lock, final test once."""
import copy
import hashlib
import json

import pandas as pd
import pytest

from src import data, run
from tests.conftest import random_funding, random_walk_df

SYMBOLS = ["AAAUSDT", "BBBUSDT", "CCCUSDT"]


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    """Synthetic 3-pair universe from 2024-08-01 to 2025-02-28 with short DEV / VAL / TEST windows."""
    real_cfg = data.load_config()
    cfg = copy.deepcopy(real_cfg)
    cfg["data"].update(start="2024-08-01", warmup_days=10, end_month="2025-02")
    cfg["sets"] = {"dev": {"start": "2024-08-01", "end": "2024-10-31"},
                   "val": {"start": "2024-11-01", "end": "2024-12-31"},
                   "test": {"start": "2025-01-01", "end": None}}
    cfg["selection"].update(dev_min_trades=5)
    cfg["stats"].update(bootstrap_resamples=200, baseline_simulations=50, baseline_pool_min=60,
                        baseline_pool_per_trade=1, baseline_pool_max=60)
    state = {"cfg": cfg}
    monkeypatch.setattr(data, "load_config", lambda path=None: copy.deepcopy(state["cfg"]))
    monkeypatch.setattr(data, "PARQUET_DIR", tmp_path / "parquet")
    monkeypatch.setattr(data, "PAIRS_PATH", tmp_path / "pairs.json")
    monkeypatch.setattr(run, "RESULTS", tmp_path / "results")
    monkeypatch.setattr(run, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(run, "LOG_PATH", tmp_path / "results" / "run_log.txt")
    monkeypatch.setattr(run, "ROOT", tmp_path)
    (tmp_path / "parquet" / "klines").mkdir(parents=True)
    (tmp_path / "parquet" / "funding").mkdir(parents=True)
    (tmp_path / "results").mkdir()
    start = data.to_ms("2024-08-01")
    n = 212 * 96
    pairs = []
    for i, sym in enumerate(SYMBOLS):
        df = random_walk_df(n, seed=100 + i, start_ms=start)
        fd = random_funding(n, seed=100 + i, start_ms=start)
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
        fd["funding_time"] = pd.to_datetime(fd["funding_time"], unit="ms", utc=True)
        df.to_parquet(tmp_path / "parquet" / "klines" / f"{sym}.parquet", index=False)
        fd.to_parquet(tmp_path / "parquet" / "funding" / f"{sym}.parquet", index=False)
        pairs.append({"symbol": sym, "onboardDate": start, "onboardDateUTC": "2024-08-01 00:00:00+00:00",
                      "avg_daily_quote_volume_90d": 1.0e9})
    (tmp_path / "pairs.json").write_text(json.dumps({"pairs": pairs}))
    return tmp_path, state


def _hashes(folder):
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob("trades_*.csv"))}


def test_pipeline_dev_val_then_locked_test(sandbox):
    tmp, state = sandbox
    res = tmp / "results"
    run.main(["backtest", "--set", "dev,val", "--workers", "1"])
    dev = pd.read_csv(res / "summary_dev.csv")
    assert len(dev) == 100 and dev["config_id"].nunique() == 100
    assert {"pass_dev", "plateau_share", "pass_plateau", "baseline_p95", "ci_low"} <= set(dev.columns)
    val = pd.read_csv(res / "summary_val.csv")
    assert set(val["config_id"]) == set(dev.loc[dev["pass_dev"], "config_id"])       # only DEV survivors go to VAL
    assert len(val) > 0, "no synthetic configuration reached VAL: integration test would be empty"
    assert {"verdict", "criteria_failed", "expectancy_costs_x2"} <= set(val.columns)
    selection = json.loads((res / "selection.json").read_text())
    assert set(selection["families"]) == {"A", "B", "C", "D", "E"}
    for fam, entry in selection["families"].items():                                  # at most one config per family
        if entry["selected"]:
            row = val.set_index("config_id").loc[entry["selected"]]
            assert row["family"] == fam and bool(row["pass_plateau"])
            best = val[(val["family"] == fam) & val["pass_plateau"]]["expectancy_r"].max()
            assert row["expectancy_r"] == best
    trials = pd.read_csv(tmp / "TRIALS.csv")
    assert trials[trials["set"] == "dev"]["config_id"].nunique() == 100
    # no trade of the DEV / VAL runs touches the TEST period
    limit = pd.Timestamp("2025-01-01", tz="UTC")
    for p in res.glob("trades_*.csv"):
        t = pd.read_csv(p, parse_dates=["entry_time", "exit_time", "signal_time"])
        assert (t["exit_time"] < limit).all() and (t["signal_time"] < limit).all()
        name = p.name
        if "_dev" in name and len(t):
            assert (t["exit_time"] < pd.Timestamp("2024-11-01", tz="UTC")).all()
    # second run: byte-identical trade files
    first = _hashes(res)
    for p in res.glob("trades_*.csv"):
        p.unlink()
    run.main(["backtest", "--set", "dev,val", "--workers", "2"])
    assert _hashes(res) == first and len(first) >= 100
    # the report can be generated while TEST is locked
    run.main(["report"])
    report = (tmp / "REPORT.md").read_text()
    assert "TEST : **verrouillé**" in report and "## Limites" in report and "## Ce que ces résultats ne prouvent pas" in report
    assert (tmp / "SETUPS_RETENUS.md").exists() and (res / "comparaison_familles.png").exists()
    # TEST is refused while locked
    with pytest.raises(data.TestSetLockedError):
        run.main(["backtest", "--set", "test", "--workers", "1"])
    assert not (res / "summary_test.csv").exists()
    log = (res / "run_log.txt").read_text()
    assert "final_test_unlocked=False" in log and "2025-01-01" in log

    # after the unlock, only the survivors of VAL are evaluated, and only once
    selection["families"]["C"].update(selected="C_tf1h_dc20_voloff", survives_val=True)
    for fam in "ABDE":
        selection["families"][fam]["survives_val"] = False
    (res / "selection.json").write_text(json.dumps(selection))
    if "C_tf1h_dc20_voloff" not in set(val["config_id"]):
        extra = dev[dev["config_id"] == "C_tf1h_dc20_voloff"].copy()
        extra["verdict"] = "REJETE"
        pd.concat([val, extra]).to_csv(res / "summary_val.csv", index=False)
    state["cfg"]["final_test_unlocked"] = True
    run.main(["backtest", "--set", "test", "--workers", "1"])
    test = pd.read_csv(res / "summary_test.csv")
    assert list(test["config_id"]) == ["C_tf1h_dc20_voloff"]
    t = pd.read_csv(res / "trades_C_tf1h_dc20_voloff_test.csv", parse_dates=["signal_time"])
    assert len(t) > 0 and (t["signal_time"] >= limit).all()
    assert json.loads((res / "retained.json").read_text())["retained"] in ([], [
        {"family": "C", "config_id": "C_tf1h_dc20_voloff", "params": json.loads(test["params"].iloc[0])}])
    with pytest.raises(RuntimeError):
        run.main(["backtest", "--set", "test", "--workers", "1"])          # the final test runs once
    run.main(["report"])
    assert "ouvert une seule fois" in (tmp / "REPORT.md").read_text()
