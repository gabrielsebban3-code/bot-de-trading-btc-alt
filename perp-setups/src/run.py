"""Command line: download | validate-data | backtest | report.

    python -m src.run download
    python -m src.run validate-data
    python -m src.run backtest --set dev,val
    python -m src.run report
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from . import data, engine, metrics, setups

ROOT = data.ROOT
RESULTS = data.RESULTS_DIR
CACHE = ROOT / "data" / "cache"
LOG_PATH = RESULTS / "run_log.txt"
SET_INDEX = {"dev": 0, "val": 1, "test": 2}

# filled once in the parent process, inherited by forked workers
_G: dict = {}


def log(msg: str) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    line = f"{pd.Timestamp.now(tz='UTC').strftime('%Y-%m-%d %H:%M:%S')}Z | {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def check_sets_allowed(cfg: dict, sets: list[str]) -> None:
    """Raise TestSetLockedError if TEST is requested while the lock is on."""
    for name in sets:
        data.set_bounds_ms(cfg, name)


# ---------------------------------------------------------------- download / validate

def cmd_download(args) -> None:
    cfg = data.load_config()
    if not data.PAIRS_PATH.exists():
        info_path = data.RAW_DIR / "exchangeInfo.json"
        if not info_path.exists():
            url = cfg["data"]["api_base"] + "/fapi/v1/exchangeInfo"
            log(f"pairs.json missing: fetching {url}")
            resp = data._http_get(url)   # raises DataUnavailableError with the exact HTTP status
            info_path.parent.mkdir(parents=True, exist_ok=True)
            info_path.write_bytes(resp.content)
        sel = data.select_pairs(cfg, info_path)
        log(f"pair selection done: {[p['symbol'] for p in sel['pairs']]}")
        (RESULTS / "pair_selection.json").write_text(json.dumps({
            "volume_window": sel["volume_window"], "n_candidates": sel["n_candidates"],
            "n_without_volume_data": sel["n_without_volume_data"], "dropped": sel["dropped"],
            "ranking_top40": [{"symbol": s["symbol"], "avg_daily_quote_volume_90d": s["avg_daily_quote_volume_90d"],
                               "onboardDate": s["onboardDate"]} for s in sel["ranking"][:40]],
        }, indent=2) + "\n", encoding="utf-8")
    pairs = data.load_pairs()
    log(f"downloading archives for {len(pairs)} pairs up to {cfg['data']['end_month']}")

    def _one(p):
        res = data.download_symbol(cfg, p["symbol"], p["onboardDate"])
        res.update(data.build_parquet(cfg, p["symbol"]))
        return res

    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(_one, pairs))
    (RESULTS / "download_info.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    for r in results:
        log(f"{r['symbol']}: {r['rows']} candles, {r['funding_rows']} funding rows, "
            f"missing kline months {r['missing_kline_months']}, missing funding months {r['missing_funding_months']}")


def cmd_validate(args) -> None:
    cfg = data.load_config()
    pairs = data.load_pairs()
    limit = data.max_readable_ms(cfg)
    log(f"validate-data: readable limit {data.ms_to_ts(limit)} (final_test_unlocked={cfg['final_test_unlocked']})")
    dl = {}
    p_dl = RESULTS / "download_info.json"
    if p_dl.exists():
        dl = {r["symbol"]: r for r in json.loads(p_dl.read_text())}
    stats = [data.quality_stats(cfg, p["symbol"], p["onboardDate"], dl.get(p["symbol"])) for p in pairs]
    excluded = [s["symbol"] for s in stats if s["missing_pct"] > cfg["data"]["max_missing_pct"]]
    scope = "DEV+VAL+TEST" if cfg["final_test_unlocked"] else "DEV+VAL (TEST verrouillé, non lu)"
    lines = ["# Contrôle qualité des données", "",
             f"Périmètre contrôlé : **{scope}**, bougies 15m jusqu'au {data.ms_to_ts(limit - data.BAR_MS)} inclus.",
             "", "Source : archives mensuelles data.binance.vision (klines 15m et fundingRate), sommes de contrôle "
             "SHA-256 vérifiées. Aucune bougie n'est comblée ni interpolée.", "",
             f"Paires exclues (> {cfg['data']['max_missing_pct']} % de bougies manquantes) : "
             f"**{', '.join(excluded) if excluded else 'aucune'}**", "",
             "| Paire | Première bougie | Attendues | Reçues | Manquantes | % manq. | Trous | Doublons retirés | "
             "Volume nul | high<low | close hors [low,high] | Bougies >30 % | Lignes funding |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for s in stats:
        lines.append(f"| {s['symbol']} | {s['first_candle'][:16]} | {s['expected']} | {s['received']} | {s['missing']} | "
                     f"{s['missing_pct']:.4f} | {len(s['gaps'])} | {s['duplicates_removed']} | {s['zero_volume']} | "
                     f"{s['high_lt_low']} | {s['close_outside_range']} | {len(s['big_moves'])} | {s['funding_rows']} |")
    lines += ["", "## Trous (intervalles manquants)", ""]
    any_gap = False
    for s in stats:
        for a, b, n in s["gaps"]:
            any_gap = True
            lines.append(f"- {s['symbol']} : {a[:16]} → {b[:16]} ({n} bougie(s))")
    if not any_gap:
        lines.append("Aucun trou.")
    lines += ["", "## Bougies avec mouvement > 30 % (listées, non supprimées)", "",
              "Mouvement = |close/open - 1| ou amplitude high/low - 1.", ""]
    any_big = False
    for s in stats:
        for when, move, rng in s["big_moves"]:
            any_big = True
            lines.append(f"- {s['symbol']} {when[:16]} : corps {move} %, amplitude {rng} %")
    if not any_big:
        lines.append("Aucune.")
    lines += ["", "## Mois d'archives absents", ""]
    any_missing = False
    for sym, r in dl.items():
        if r.get("missing_kline_months") or r.get("missing_funding_months"):
            any_missing = True
            lines.append(f"- {sym} : klines {r['missing_kline_months']}, funding {r['missing_funding_months']}")
    if not any_missing:
        lines.append("Aucun.")
    (RESULTS / "data_quality.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (RESULTS / "excluded_pairs.json").write_text(json.dumps({"excluded": excluded, "scope": scope}, indent=2) + "\n")
    log(f"data_quality.md written; excluded pairs: {excluded}")


# ---------------------------------------------------------------- market loading

def active_pairs(cfg: dict) -> list[dict]:
    excluded = set()
    p = RESULTS / "excluded_pairs.json"
    if p.exists():
        excluded = set(json.loads(p.read_text())["excluded"])
    return [x for x in data.load_pairs() if x["symbol"] not in excluded]


def load_market(cfg: dict, symbols: list[str]) -> tuple[dict, dict]:
    market, ctxs = {}, {}
    for sym in symbols:
        df = data.load_klines(cfg, sym)
        fd = data.load_funding(cfg, sym)
        ctx = setups.SymbolContext(sym, df, fd, cfg)
        sd = engine.SymbolData(sym, df, fd)
        for tf in ("15m", "1h", "4h"):
            b = ctx.bars[tf]
            sd.add_tf(tf, b.ot, b.h, b.l, b.atr)
        market[sym], ctxs[sym] = sd, ctx
    return market, ctxs


def get_signals(cfg: dict, ctxs: dict, config: dict, use_cache: bool = True) -> pd.DataFrame:
    """Orders of one configuration for every symbol (cached on disk per readable limit)."""
    # pickle (not parquet): forked workers must not touch pyarrow's thread pools
    path = CACHE / f"signals_{data.max_readable_ms(cfg)}" / f"{config['config_id']}.pkl"
    if use_cache and path.exists():
        return pd.read_pickle(path)
    frames = [setups.generate_signals(ctxs[s], config) for s in sorted(ctxs)]
    frames = [f for f in frames if len(f)]
    sig = pd.concat(frames, ignore_index=True) if frames else setups._empty_signals()
    if use_cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        sig.to_pickle(path)
    return sig


# ---------------------------------------------------------------- baseline

def baseline_distribution(market: dict, ctxs: dict, cfg: dict, config: dict, trades: pd.DataFrame, info: dict,
                          start_ms: int, end_ms: int, cost_mult: float = 1.0, set_name: str = "dev",
                          pool_size: int | None = None, n_sims: int | None = None) -> np.ndarray:
    """Mean R of ``n_sims`` random-entry simulations with as many trades as the configuration."""
    n = len(trades)
    st = cfg["stats"]
    n_sims = n_sims or st["baseline_simulations"]
    if n == 0:
        return np.zeros(0)
    spec = setups.exit_spec(cfg, config)
    tf = spec["tf"]
    rng = np.random.default_rng([cfg["seed"], config.get("index", 0), SET_INDEX.get(set_name, 9), 1])
    eligible = {}
    for sym in sorted(set(trades["symbole"])):
        b = ctxs[sym].bars[tf]
        valid = b.valid(ctxs[sym].warmup_ms)
        ok = np.zeros(b.size, dtype=bool)
        ok[1:] = b.contig[1:] & valid[:-1] & np.isfinite(b.atr[:-1])
        ok &= (b.ot >= start_ms) & (b.ot < end_ms)
        eligible[sym] = np.nonzero(ok)[0]
    if pool_size is None:
        pool_size = int(min(st["baseline_pool_max"], max(st["baseline_pool_min"], st["baseline_pool_per_trade"] * n)))
    pool = engine.baseline_pool(market, cfg, start_ms, end_ms, tf, eligible, trades["symbole"].to_numpy(),
                                info["stop_dist_atr"], info["tp_dist_atr"], spec["tp_mode"], spec["tp_r"],
                                spec["trail_mult"], spec["max_hold_ms"], spec["entry_is_limit"], pool_size, rng,
                                cost_mult)
    if len(pool) == 0:
        return np.zeros(0)
    means = np.empty(n_sims)
    chunk = max(1, min(n_sims, 4_000_000 // n))
    done = 0
    while done < n_sims:
        m = min(chunk, n_sims - done)
        means[done: done + m] = pool[rng.integers(0, len(pool), size=(m, n))].mean(axis=1)
        done += m
    return means


# ---------------------------------------------------------------- evaluation of one configuration

def trades_path(config_id: str, set_name: str, cost_mult: float = 1.0) -> Path:
    suffix = "" if cost_mult == 1.0 else "_couts_x2"
    return RESULTS / f"trades_{config_id}_{set_name}{suffix}.csv"


def evaluate(task: tuple) -> dict:
    """Worker: run one configuration on one set. task = (config index, set name, with_costs_x2)."""
    idx, set_name, with_x2 = task
    cfg, market, ctxs, configs = _G["cfg"], _G["market"], _G["ctxs"], _G["configs"]
    config = configs[idx]
    start_ms, end_ms = data.set_bounds_ms(cfg, set_name)
    t0 = time.time()
    sig = get_signals(cfg, ctxs, config)
    trades, info = engine.run_backtest(sig, market, cfg, start_ms, end_ms, config["family"], config["config_id"])
    trades.to_csv(trades_path(config["config_id"], set_name), index=False, float_format="%.10g")
    rng = np.random.default_rng([cfg["seed"], idx, SET_INDEX[set_name], 0])
    m = metrics.compute_metrics(trades, cfg, start_ms, end_ms, rng)
    base = baseline_distribution(market, ctxs, cfg, config, trades, info, start_ms, end_ms, set_name=set_name)
    row = {"family": config["family"], "config_id": config["config_id"],
           "params": json.dumps(config["params"], sort_keys=True), "set": set_name, "cost_mult": 1.0}
    row.update(m)
    for k in ("signals", "skip_pair_busy", "skip_portfolio_full", "skip_filter", "skip_no_bar", "limit_expired",
              "void_gap", "leverage_capped", "liquidations"):
        row[k] = info[k]
    if len(base):
        row["baseline_median"] = float(np.median(base))
        row["baseline_p95"] = float(np.quantile(base, cfg["verdict"]["baseline_percentile"] / 100.0))
        row["baseline_percentile"] = float(100.0 * (base < m["expectancy_r"]).mean())
    else:
        row["baseline_median"] = row["baseline_p95"] = row["baseline_percentile"] = float("nan")
    bd = metrics.breakdowns(trades)
    bd.insert(0, "config_id", config["config_id"])
    bd.insert(1, "set", set_name)
    x2_row = None
    if with_x2:
        mult = cfg["costs"]["sensitivity_multiplier"]
        trades2, _ = engine.run_backtest(sig, market, cfg, start_ms, end_ms, config["family"], config["config_id"], mult)
        trades2.to_csv(trades_path(config["config_id"], set_name, mult), index=False, float_format="%.10g")
        m2 = metrics.compute_metrics(trades2, cfg, start_ms, end_ms, np.random.default_rng([cfg["seed"], idx, 7]))
        x2_row = {"family": config["family"], "config_id": config["config_id"], "params": row["params"],
                  "set": set_name, "cost_mult": mult, "n_trades": m2["n_trades"],
                  "expectancy_r": m2["expectancy_r"], "profit_factor": m2["profit_factor"],
                  "win_rate": m2["win_rate"], "max_dd_pct": m2["max_dd_pct"]}
        v = metrics.verdict_details(trades, m, m2["expectancy_r"], row["baseline_p95"], cfg)
        row.update(v)
    row["seconds"] = round(time.time() - t0, 1)
    return {"idx": idx, "row": row, "breakdown": bd, "x2": x2_row}


def _run_tasks(tasks: list[tuple], workers: int) -> list[dict]:
    if not tasks:
        return []
    if workers <= 1:
        res = [evaluate(t) for t in tasks]
    else:
        ctx = mp.get_context("fork")
        with ctx.Pool(workers) as pool:
            res = pool.map(evaluate, tasks, chunksize=1)
    return sorted(res, key=lambda r: r["idx"])


TRIAL_COLS = ["family", "config_id", "params", "set", "cost_mult", "n_trades", "expectancy_r", "profit_factor",
              "win_rate", "max_dd_pct"]


def write_trials() -> None:
    """TRIALS.csv = every (configuration, set, cost level) ever evaluated, rebuilt from the summaries."""
    frames = []
    for name in ("dev", "val", "test"):
        p = RESULTS / f"summary_{name}.csv"
        if p.exists():
            frames.append(pd.read_csv(p)[TRIAL_COLS])
        p2 = RESULTS / f"costs_x2_{name}.csv"
        if p2.exists():
            frames.append(pd.read_csv(p2)[TRIAL_COLS])
    if frames:
        pd.concat(frames, ignore_index=True).to_csv(ROOT / "TRIALS.csv", index=False, float_format="%.6g")


def write_buy_hold(cfg: dict, market: dict, sets: list[str]) -> None:
    p = RESULTS / "buy_hold.csv"
    old = pd.read_csv(p) if p.exists() else pd.DataFrame(columns=["set", "symbol", "return_pct", "max_dd_pct", "first", "last"])
    old = old[~old["set"].isin(sets)]
    rows = []
    for name in sets:
        s, e = data.set_bounds_ms(cfg, name)
        for sym, sd in sorted(market.items()):
            mask = (sd.ot >= s) & (sd.ot < e)
            if mask.sum() < 2:
                continue
            ret, dd = metrics.buy_and_hold(sd.c[mask])
            rows.append({"set": name, "symbol": sym, "return_pct": round(ret, 2), "max_dd_pct": round(dd, 2),
                         "first": str(data.ms_to_ts(sd.ot[mask][0])), "last": str(data.ms_to_ts(sd.ot[mask][-1]))})
    pd.concat([old, pd.DataFrame(rows)], ignore_index=True).to_csv(p, index=False)


def _save_breakdowns(results: list[dict], set_name: str) -> None:
    frames = [r["breakdown"] for r in results if len(r["breakdown"])]
    out = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    out.to_csv(RESULTS / f"breakdown_{set_name}.csv", index=False, float_format="%.6g")


def cmd_backtest(args) -> None:
    cfg = data.load_config()
    sets = [s.strip() for s in args.set.split(",") if s.strip()]
    check_sets_allowed(cfg, sets)       # raises while TEST is locked
    limit = data.max_readable_ms(cfg)
    log(f"backtest --set {','.join(sets)} | final_test_unlocked={cfg['final_test_unlocked']} | "
        f"data readable strictly before {data.ms_to_ts(limit)}")
    pairs = active_pairs(cfg)
    symbols = [p["symbol"] for p in pairs]
    configs = setups.all_configs(cfg)
    market, ctxs = load_market(cfg, symbols)
    last_loaded = max(int(sd.ot[-1]) for sd in market.values())
    log(f"loaded {len(symbols)} pairs; last candle in memory {data.ms_to_ts(last_loaded)}")
    _G.update(cfg=cfg, market=market, ctxs=ctxs, configs=configs)
    workers = args.workers
    write_buy_hold(cfg, market, sets)

    if "dev" in sets:
        res = _run_tasks([(i, "dev", False) for i in range(len(configs))], workers)
        dev = pd.DataFrame([r["row"] for r in res])
        dev["pass_dev"] = [metrics.passes_dev(r, cfg) for r in dev.to_dict("records")]
        exp = dict(zip(dev["config_id"], dev["expectancy_r"]))
        shares = []
        for c in configs:
            shares.append(metrics.plateau_share([exp.get(n["config_id"]) for n in setups.neighbours(c, configs)]))
        dev["plateau_share"] = shares
        dev["pass_plateau"] = dev["plateau_share"] >= cfg["selection"]["plateau_min_share"]
        dev.to_csv(RESULTS / "summary_dev.csv", index=False, float_format="%.6g")
        _save_breakdowns(res, "dev")
        log(f"DEV done: {len(dev)} configurations, {int(dev['pass_dev'].sum())} pass DEV, "
            f"{int((dev['pass_dev'] & dev['pass_plateau']).sum())} pass DEV + plateau")

    if "val" in sets:
        dev = pd.read_csv(RESULTS / "summary_dev.csv")
        by_id = {c["config_id"]: c for c in configs}
        todo = [by_id[cid]["index"] for cid in dev.loc[dev["pass_dev"], "config_id"]]
        res = _run_tasks([(i, "val", True) for i in todo], workers)
        val = pd.DataFrame([r["row"] for r in res])
        if len(val):
            flags = dev.set_index("config_id")[["plateau_share", "pass_plateau"]]
            val = val.join(flags, on="config_id")
            val["dev_expectancy_r"] = val["config_id"].map(dev.set_index("config_id")["expectancy_r"])
            val["dev_n_trades"] = val["config_id"].map(dev.set_index("config_id")["n_trades"])
        val.to_csv(RESULTS / "summary_val.csv", index=False, float_format="%.6g")
        pd.DataFrame([r["x2"] for r in res if r["x2"]]).to_csv(RESULTS / "costs_x2_val.csv", index=False,
                                                              float_format="%.6g")
        _save_breakdowns(res, "val")
        selection = select_per_family(cfg, dev, val)
        (RESULTS / "selection.json").write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
        survivors = [f"{k}:{v['selected']}" for k, v in selection["families"].items() if v["survives_val"]]
        log(f"VAL done: {len(val)} configurations evaluated; survivors of VAL: {survivors or 'none'}")

    if "test" in sets:
        if (RESULTS / "summary_test.csv").exists():
            raise RuntimeError("summary_test.csv already exists: the final test is run only once.")
        selection = json.loads((RESULTS / "selection.json").read_text())
        by_id = {c["config_id"]: c for c in configs}
        todo = [by_id[v["selected"]]["index"] for v in selection["families"].values() if v["survives_val"]]
        log(f"FINAL TEST on {len(todo)} surviving configuration(s): {[configs[i]['config_id'] for i in todo]}")
        res = _run_tasks([(i, "test", True) for i in todo], workers)
        test = pd.DataFrame([r["row"] for r in res])
        test.to_csv(RESULTS / "summary_test.csv", index=False, float_format="%.6g")
        pd.DataFrame([r["x2"] for r in res if r["x2"]]).to_csv(RESULTS / "costs_x2_test.csv", index=False,
                                                              float_format="%.6g")
        _save_breakdowns(res, "test")
        retained = []
        val = pd.read_csv(RESULTS / "summary_val.csv").set_index("config_id")
        for r in test.to_dict("records"):
            if r["verdict"] == "PASSE" and val.loc[r["config_id"], "verdict"] == "PASSE":
                retained.append({"family": r["family"], "config_id": r["config_id"],
                                 "params": json.loads(r["params"])})
        (RESULTS / "retained.json").write_text(json.dumps({"retained": retained}, indent=2) + "\n", encoding="utf-8")
        log(f"FINAL TEST done: retained = {[r['config_id'] for r in retained] or 'none'}")
    write_trials()


def select_per_family(cfg: dict, dev: pd.DataFrame, val: pd.DataFrame) -> dict:
    """Section 7: one configuration per family = best VAL expectancy among DEV + plateau survivors."""
    out = {"families": {}, "n_configs_tested_dev": int(len(dev)), "n_configs_evaluated_val": int(len(val))}
    for fam in sorted(cfg["families"]):
        d = dev[dev["family"] == fam]
        entry = {"n_grid": int(len(d)), "n_pass_dev": int(d["pass_dev"].sum()),
                 "n_pass_dev_and_plateau": int((d["pass_dev"] & d["pass_plateau"]).sum()),
                 "n_dev_with_100_trades": int((d["n_trades"] >= cfg["selection"]["dev_min_trades"]).sum()),
                 "selected": None, "survives_val": False, "val_verdict": None, "val_criteria_failed": None}
        v = val[(val["family"] == fam) & (val["pass_plateau"])] if len(val) else val
        if len(v):
            best = v.sort_values(["expectancy_r", "config_id"], ascending=[False, True]).iloc[0]
            entry.update(selected=best["config_id"], val_verdict=best["verdict"],
                         val_criteria_failed=best["criteria_failed"] if isinstance(best["criteria_failed"], str) else "",
                         survives_val=bool(best["verdict"] == "PASSE"))
        else:
            ranked = d.sort_values(["n_trades"], ascending=False)
            enough = d[d["n_trades"] >= cfg["selection"]["dev_min_trades"]]
            pool = enough if len(enough) else ranked
            if len(pool) and pool["expectancy_r"].notna().any():
                entry["best_dev_only"] = pool.sort_values(["expectancy_r", "config_id"],
                                                          ascending=[False, True]).iloc[0]["config_id"]
            entry["val_verdict"] = "REJETE" if len(enough) else "INSUFFISANT"
        out["families"][fam] = entry
    return out


def cmd_report(args) -> None:
    from . import report  # noqa: WPS433  (kept separate only for readability of this file)
    report.build(args)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m src.run")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("download")
    sub.add_parser("validate-data")
    bt = sub.add_parser("backtest")
    bt.add_argument("--set", default="dev,val")
    bt.add_argument("--workers", type=int, default=4)
    sub.add_parser("report")
    args = parser.parse_args(argv)
    {"download": cmd_download, "validate-data": cmd_validate, "backtest": cmd_backtest, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    main(sys.argv[1:])
