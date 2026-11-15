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
        if s["received"] == 0:      # listed after the readable limit: nothing to check yet
            lines.append(f"| {s['symbol']} | aucune bougie dans le périmètre | 0 | 0 | 0 | - | 0 | - | 0 | 0 | 0 | 0 | "
                         f"{s['funding_rows']} |")
            continue
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
        if len(df) == 0:            # pair listed after the readable limit (e.g. listed during TEST while locked)
            log(f"{sym}: no candle before the readable limit, pair skipped for this run")
            continue
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
    symbols = sorted(market)
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


# ================================================================ report (French deliverables)

FAMILY_RULES = {
    "A": ("Sweep d'equal highs/lows (au moins 2 pivots à moins de {tol:.2f} % l'un de l'autre parmi les pivots confirmés "
          "des {lb} dernières bougies, niveau encore intact), puis cassure de structure (clôture au-delà du dernier "
          "pivot opposé confirmé) dans les {mss} bougies, puis ordre **limite** au milieu de la zone (FVG ou order "
          "block), valable {val} bougies. Stop au-delà de la mèche du sweep (marge {mar} × ATR). Objectif fixe en R."),
    "B": ("Tendance EMA50/EMA200 du timeframe, repli sur l'EMA20 dans les {pw} dernières bougies avec clôture revenue "
          "du bon côté, RSI(14) repassé au-delà du seuil après l'avoir franchi dans les {rl} bougies précédentes. "
          "Entrée au marché à l'ouverture suivante. Stop {sa} × ATR ou dernier pivot (n = {pn}). Sortie objectif "
          "{tp} R ou stop suiveur chandelier {tr} × ATR."),
    "C": ("Clôture au-delà du plus haut / plus bas des N bougies précédentes (Donchian), filtre optionnel volume > "
          "{vm} × moyenne des {vw} bougies précédentes. Entrée au marché à l'ouverture suivante, stop initial "
          "{sa} × ATR, stop suiveur chandelier {tr} × ATR."),
    "D": ("ADX(14) < {adx}, clôture hors des bandes de Bollinger(20, k) et RSI(14) extrême. Entrée au marché à "
          "l'ouverture suivante, stop {sa} × ATR, objectif = moyenne mobile 20 figée à l'entrée, sortie au marché "
          "après {mh} bougies."),
    "E": ("z-score du dernier funding (sur les {zw} règlements précédents) au-delà de ±z : position contraire, "
          "après confirmation 1h (clôture au-delà de l'extrême de la bougie précédente) dans les {cw} h. Entrée au "
          "marché, stop {sa} × ATR, objectif {tp} R, durée maximale de détention."),
}


def _rules_text(cfg: dict, fam: str) -> str:
    fx = cfg["families"][fam]["fixed"]
    if fam == "A":
        return FAMILY_RULES[fam].format(tol=100 * fx["equal_level_tol"], lb=fx["pivot_lookback_bars"],
                                        mss=fx["mss_window_bars"], val=fx["limit_validity_bars"],
                                        mar=fx["stop_margin_atr"])
    if fam == "B":
        return FAMILY_RULES[fam].format(pw=fx["pullback_window_bars"], rl=fx["rsi_lookback_bars"],
                                        sa=fx["stop_atr_mult"], pn=fx["pivot_n"], tp=fx["tp_r"], tr=fx["trail_atr_mult"])
    if fam == "C":
        return FAMILY_RULES[fam].format(vm=fx["volume_mult"], vw=fx["volume_window_bars"], sa=fx["stop_atr_mult"],
                                        tr=fx["trail_atr_mult"])
    if fam == "D":
        return FAMILY_RULES[fam].format(adx=fx["adx_max"], sa=fx["stop_atr_mult"], mh=fx["max_hold_bars"])
    return FAMILY_RULES[fam].format(zw=fx["z_window"], cw=fx["confirm_window_hours"], sa=fx["stop_atr_mult"],
                                    tp=fx["tp_r"])


def _n(x, nd: int = 2, pct: bool = False) -> str:
    """French-style number formatting for the report."""
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "n/d"
    if isinstance(x, (bool, np.bool_)):
        return "oui" if x else "non"
    txt = f"{x:,.{nd}f}".replace(",", " ").replace(".", ",")
    if nd > 0 and float(x) > 0 and pct is None:
        txt = "+" + txt
    return txt + (" %" if pct else "")


def _r(x) -> str:
    if x is None or not np.isfinite(x):
        return "n/d"
    return f"{x:+.3f}".replace(".", ",") + " R"


def _table(headers: list[str], rows: list[list], align: list[str] | None = None) -> str:
    align = align or ["---"] * len(headers)
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(align) + "|"]
    for row in rows:
        out.append("| " + " | ".join(str(c) for c in row) + " |")
    return "\n".join(out)


def _read(name: str) -> pd.DataFrame:
    p = RESULTS / name
    if p.exists() and p.stat().st_size > 2:
        try:
            return pd.read_csv(p)
        except pd.errors.EmptyDataError:
            return pd.DataFrame()
    return pd.DataFrame()


def _read_trades(config_id: str, set_name: str) -> pd.DataFrame:
    p = trades_path(config_id, set_name)
    if not p.exists():
        return pd.DataFrame()
    t = pd.read_csv(p)
    for col in ("signal_time", "entry_time", "exit_time"):
        t[col] = pd.to_datetime(t[col], utc=True)
    return t


def _plot_family(plt, config_id: str, set_label: str, trades: pd.DataFrame, cfg: dict) -> list[str]:
    """Equity in cumulative R, drawdown, histogram of R, heatmap pair x quarter. Returns file names."""
    files = []
    t = trades.sort_values(["exit_time", "trade_id"])
    cum = t["r_multiple_net"].cumsum().to_numpy()
    when = t["exit_time"].dt.tz_localize(None).to_numpy()
    fig, ax = plt.subplots(figsize=(10, 4.2))
    ax.plot(when, cum, color="#1f4e79", lw=1.3)
    ax.axhline(0, color="grey", lw=0.8)
    ax.set_title(f"{config_id} — courbe de capital en R cumulés ({set_label})")
    ax.set_xlabel("Date de sortie des trades (UTC)")
    ax.set_ylabel("R cumulés (nets de frais, slippage, funding)")
    ax.grid(alpha=0.3)
    name = f"equity_{config_id}.png"
    fig.tight_layout(); fig.savefig(RESULTS / name, dpi=110, facecolor="white"); plt.close(fig)
    files.append(name)

    peak = np.maximum.accumulate(np.concatenate(([0.0], cum)))[1:]
    fig, ax = plt.subplots(figsize=(10, 3.2))
    ax.fill_between(when, -(peak - cum), 0, color="#b03a2e", alpha=0.6, step="post")
    ax.set_title(f"{config_id} — drawdown en R ({set_label})")
    ax.set_xlabel("Date (UTC)"); ax.set_ylabel("Écart au plus haut (R)")
    ax.grid(alpha=0.3)
    name = f"drawdown_{config_id}.png"
    fig.tight_layout(); fig.savefig(RESULTS / name, dpi=110, facecolor="white"); plt.close(fig)
    files.append(name)

    fig, ax = plt.subplots(figsize=(8, 4))
    r = t["r_multiple_net"].to_numpy()
    ax.hist(np.clip(r, -3, 8), bins=55, color="#1f4e79", alpha=0.85)
    ax.axvline(r.mean(), color="#b03a2e", lw=1.5, label=f"Moyenne {r.mean():+.3f} R")
    ax.axvline(0, color="grey", lw=0.8)
    ax.set_title(f"{config_id} — distribution des R nets ({set_label})")
    ax.set_xlabel("R net par trade (valeurs au-delà de −3 / +8 regroupées)"); ax.set_ylabel("Nombre de trades")
    ax.legend()
    name = f"hist_{config_id}.png"
    fig.tight_layout(); fig.savefig(RESULTS / name, dpi=110, facecolor="white"); plt.close(fig)
    files.append(name)

    et = t["entry_time"].dt.tz_localize(None)
    q = et.dt.year.astype(str) + "-T" + et.dt.quarter.astype(str)
    piv = t.assign(q=q.to_numpy()).pivot_table(index="symbole", columns="q", values="r_multiple_net", aggfunc="mean")
    fig, ax = plt.subplots(figsize=(max(7, 1.0 * piv.shape[1] + 3), max(4, 0.32 * piv.shape[0] + 1.5)))
    lim = 1.0
    im = ax.imshow(piv.to_numpy(dtype="float64"), cmap="RdYlGn", vmin=-lim, vmax=lim, aspect="auto")
    ax.set_xticks(range(piv.shape[1])); ax.set_xticklabels(piv.columns, rotation=45, ha="right")
    ax.set_yticks(range(piv.shape[0])); ax.set_yticklabels(piv.index)
    ax.set_title(f"{config_id} — espérance (R) par paire et par trimestre ({set_label})")
    fig.colorbar(im, ax=ax, label="Espérance en R (échelle bornée à ±1)")
    name = f"heatmap_{config_id}.png"
    fig.tight_layout(); fig.savefig(RESULTS / name, dpi=110, facecolor="white"); plt.close(fig)
    files.append(name)
    return files


def _plot_comparison(plt, rows: list[dict]) -> str | None:
    """Expectancy with 95 % CI of the configuration kept for each family (DEV, VAL, TEST when available)."""
    if not rows:
        return None
    fig, ax = plt.subplots(figsize=(10, 4.5))
    colors = {"dev": "#7f8c8d", "val": "#1f4e79", "test": "#b03a2e"}
    labels = {"dev": "DEV", "val": "VAL", "test": "TEST"}
    xt, xl = [], []
    for i, row in enumerate(rows):
        for j, name in enumerate(("dev", "val", "test")):
            m = row.get(name)
            if not m or not np.isfinite(m.get("expectancy_r", np.nan)):
                continue
            x = i + (j - 1) * 0.22
            ax.errorbar([x], [m["expectancy_r"]],
                        yerr=[[m["expectancy_r"] - m["ci_low"]], [m["ci_high"] - m["expectancy_r"]]],
                        fmt="o", color=colors[name], capsize=4, label=labels[name] if i == 0 else None)
        xt.append(i); xl.append(f"{row['family']}\n{row['config_id']}")
    ax.axhline(0, color="black", lw=0.8)
    ax.axhline(0.10, color="green", lw=0.8, ls="--", label="Seuil +0,10 R")
    ax.set_xticks(xt); ax.set_xticklabels(xl, fontsize=7)
    ax.set_ylabel("Espérance nette (R) et intervalle de confiance à 95 %")
    ax.set_title("Espérance de la configuration gardée pour chaque famille")
    handles, lab = ax.get_legend_handles_labels()
    uniq = dict(zip(lab, handles))
    ax.legend(uniq.values(), uniq.keys(), loc="best")
    ax.grid(alpha=0.3, axis="y")
    fig.tight_layout(); fig.savefig(RESULTS / "comparaison_familles.png", dpi=110, facecolor="white"); plt.close(fig)
    return "comparaison_familles.png"


def _plot_trade(plt, cfg: dict, trade: pd.Series, tf: str, title: str, name: str) -> str | None:
    """Real candles around one trade with entry, stop, target and exit."""
    try:
        df15 = data.load_klines(cfg, trade["symbole"])
    except Exception:   # noqa: BLE001 - data not on disk: no chart
        return None
    bars = data.resample(df15, tf)
    step = data.TF_MS[tf]
    e_ms = int(trade["entry_time"].value // 1_000_000)
    x_ms = int(trade["exit_time"].value // 1_000_000)
    lo, hi = e_ms - 45 * step, x_ms + 12 * step
    w = bars[(bars["open_time"] >= lo) & (bars["open_time"] <= hi)].reset_index(drop=True)
    if len(w) < 5:
        return None
    fig, ax = plt.subplots(figsize=(11, 4.8))
    x = np.arange(len(w))
    up = w["close"] >= w["open"]
    ax.vlines(x, w["low"], w["high"], color=np.where(up, "#1e8449", "#b03a2e"), lw=0.8)
    ax.bar(x, (w["close"] - w["open"]).abs().clip(lower=1e-12), bottom=np.minimum(w["open"], w["close"]),
           color=np.where(up, "#1e8449", "#b03a2e"), width=0.7)
    xe = float(np.searchsorted(w["open_time"].to_numpy(), e_ms, side="right") - 1)
    xx = float(np.searchsorted(w["open_time"].to_numpy(), x_ms, side="right") - 1)
    ax.hlines(trade["entry_price"], xe, xx, color="#1f4e79", lw=1.3, label=f"Entrée {trade['entry_price']:.6g}")
    ax.hlines(trade["stop_price"], xe, xx, color="#b03a2e", lw=1.3, ls="--", label=f"Stop initial {trade['stop_price']:.6g}")
    if np.isfinite(trade["tp_price"]):
        ax.hlines(trade["tp_price"], xe, xx, color="#1e8449", lw=1.3, ls="--", label=f"Objectif {trade['tp_price']:.6g}")
    ax.scatter([xe], [trade["entry_price"]], marker="^" if trade["direction"] == "long" else "v", s=90,
               color="#1f4e79", zorder=5)
    ax.scatter([xx], [trade["exit_price"]], marker="x", s=90, color="black", zorder=5,
               label=f"Sortie {trade['exit_price']:.6g} ({trade['exit_reason']})")
    ticks = x[:: max(1, len(x) // 8)]
    ax.set_xticks(ticks)
    ax.set_xticklabels([data.ms_to_ts(w["open_time"].iloc[i]).strftime("%d/%m %H:%M") for i in ticks], fontsize=8)
    ax.set_title(f"{title} — {trade['symbole']} {trade['direction'].upper()} ({tf}), résultat {trade['r_multiple_net']:+.2f} R")
    ax.set_xlabel("Bougies réelles Binance (UTC)"); ax.set_ylabel("Prix (USDT)")
    ax.legend(fontsize=8, loc="best"); ax.grid(alpha=0.25)
    fig.tight_layout(); fig.savefig(RESULTS / name, dpi=110, facecolor="white"); plt.close(fig)
    return name


def _describe_config(cfg: dict, config: dict) -> list[str]:
    """Plain-French rules of one configuration, with the exact parameter values."""
    fam, p = config["family"], config["params"]
    fx = cfg["families"][fam]["fixed"]
    tf = setups.timeframe_of(cfg, config)
    if fam == "A":
        zone = ("au **milieu du fair value gap** laissé par la bougie de cassure (écart entre la bougie d'avant et "
                "celle d'après)" if p["zone"] == "FVG" else
                "au **milieu du corps de la dernière bougie de couleur opposée** avant la bougie de cassure (order block)")
        struct = (f"la bougie de cassure doit avoir un corps d'au moins {fx['displacement_atr_mult']} × ATR(14)"
                  if p["structure"] == "deplacement" else "sans condition de taille sur la bougie de cassure")
        steps = [
            f"Graphique **{tf}**, bougies closes uniquement.",
            f"Repérer des **equal highs** (pour vendre) ou **equal lows** (pour acheter) : au moins 2 pivots de période "
            f"{p['pivot_n']} (plus haut/bas strict sur {p['pivot_n']} bougies de chaque côté) dans les "
            f"{fx['pivot_lookback_bars']} dernières bougies, à moins de {100 * fx['equal_level_tol']:.2f} % l'un de l'autre, "
            "niveau jamais dépassé depuis.",
            "**Sweep** : une bougie dépasse ce niveau avec sa mèche mais clôture de l'autre côté.",
            f"**Cassure de structure** dans les {fx['mss_window_bars']} bougies suivantes : première clôture au-delà du "
            f"dernier pivot opposé confirmé au moment du sweep ; {struct}.",
            f"**Entrée** : ordre limite {zone}. L'ordre est valable {fx['limit_validity_bars']} bougies {tf}, puis annulé.",
            f"**Stop** : au-delà de l'extrême de la mèche du sweep, avec une marge de {fx['stop_margin_atr']} × ATR(14).",
            f"**Sortie** : objectif fixe à **{p['tp_r']} R** (ordre limite).",
            ("**Filtre 4h** : achat seulement si EMA50(4h) > EMA200(4h), vente seulement si EMA50(4h) < EMA200(4h) "
             "(dernière bougie 4h close)." if p["htf_filter"] == "on" else "**Filtre 4h** : aucun."),
        ]
    elif fam == "B":
        lo, hi = p["rsi_thresholds"].split("/")
        stop = (f"à {fx['stop_atr_mult']} × ATR(14) du prix d'entrée" if p["stop"] == "atr"
                else f"sur le dernier pivot confirmé (période {fx['pivot_n']}) : plus bas pour un achat, plus haut pour une vente")
        exit_ = (f"objectif fixe à **{fx['tp_r']} R**" if p["exit"] == "tp2r" else
                 f"**stop suiveur chandelier** : plus haut (plus bas) des bougies closes depuis l'entrée ∓ "
                 f"{fx['trail_atr_mult']} × ATR(14), jamais reculé")
        steps = [
            f"Graphique **{tf}**, bougies closes uniquement.",
            "**Tendance** : EMA50 > EMA200 pour acheter, EMA50 < EMA200 pour vendre.",
            f"**Repli** : le prix a touché ou traversé l'EMA20 sur l'une des {fx['pullback_window_bars']} dernières bougies "
            "et la bougie courante clôture du bon côté de l'EMA20.",
            f"**RSI(14)** : repassé au-dessus de {lo} (achat) ou en dessous de {hi} (vente) après avoir été de l'autre côté "
            f"sur l'une des {fx['rsi_lookback_bars']} bougies précédentes.",
            "**Entrée** : au marché à l'ouverture de la bougie suivante.",
            f"**Stop** : {stop}.",
            f"**Sortie** : {exit_}.",
            "**Filtre 4h** : aucun.",
        ]
    elif fam == "C":
        vol = (f"volume de la bougie de cassure > {fx['volume_mult']} × moyenne des {fx['volume_window_bars']} bougies "
               "précédentes" if p["volume_filter"] == "on" else "aucun filtre de volume")
        steps = [
            f"Graphique **{tf}**, bougies closes uniquement.",
            f"**Signal** : clôture au-dessus du plus haut des {p['donchian_n']} bougies précédentes (achat) ou sous leur "
            "plus bas (vente).",
            f"**Volume** : {vol}.",
            "**Entrée** : au marché à l'ouverture de la bougie suivante.",
            f"**Stop initial** : {fx['stop_atr_mult']} × ATR(14) du prix d'entrée.",
            f"**Sortie** : stop suiveur chandelier à {fx['trail_atr_mult']} × ATR(14) (plus haut/bas des bougies closes "
            "depuis l'entrée), jamais reculé.",
            "**Filtre 4h** : aucun.",
        ]
    elif fam == "D":
        lo, hi = p["rsi_thresholds"].split("/")
        steps = [
            f"Graphique **{tf}**, bougies closes uniquement.",
            f"**Régime** : ADX(14) < {fx['adx_max']}.",
            f"**Signal** : clôture sous la bande basse de Bollinger(20, {p['bb_k']}) avec RSI(14) ≤ {lo} (achat), ou "
            f"au-dessus de la bande haute avec RSI(14) ≥ {hi} (vente).",
            "**Entrée** : au marché à l'ouverture de la bougie suivante.",
            f"**Stop** : {fx['stop_atr_mult']} × ATR(14) du prix d'entrée.",
            "**Objectif** : la moyenne mobile 20 (milieu de Bollinger) relevée à la bougie du signal, figée.",
            f"**Sortie temporelle** : au marché après {fx['max_hold_bars']} bougies {tf} si ni stop ni objectif.",
            "**Filtre 4h** : aucun.",
        ]
    else:
        steps = [
            "Graphique **1h**, bougies closes uniquement.",
            f"**Signal** : z-score du dernier funding (moyenne et écart-type des {fx['z_window']} règlements précédents) "
            f"≥ +{p['z']} (vente) ou ≤ −{p['z']} (achat).",
            f"**Confirmation** dans les {fx['confirm_window_hours']} h suivant le règlement : une bougie 1h clôture sous le "
            "plus bas de la précédente (vente) ou au-dessus de son plus haut (achat).",
            "**Entrée** : au marché à l'ouverture de la bougie suivante.",
            f"**Stop** : {fx['stop_atr_mult']} × ATR(14) du prix d'entrée. **Objectif** : {fx['tp_r']} R.",
            f"**Sortie temporelle** : au marché après {p['max_hold_hours']} h de détention.",
            "**Filtre 4h** : aucun.",
        ]
    return steps


def _row_of(df: pd.DataFrame, config_id: str) -> dict | None:
    if not len(df) or "config_id" not in df:
        return None
    hit = df[df["config_id"] == config_id]
    return hit.iloc[0].to_dict() if len(hit) else None


def _set_cell(m: dict | None) -> str:
    if not m:
        return "non évalué"
    if not m["n_trades"]:
        return "0 trade"
    return (f"{int(m['n_trades'])} trades, {_r(m['expectancy_r'])} [IC {_r(m['ci_low'])} ; {_r(m['ci_high'])}], "
            f"PF {_n(m['profit_factor'])}, DD {_n(m['max_dd_pct'], 1)} %, rdt {_n(m['total_return_pct'], 1)} %")


def _pair_lists(bd: pd.DataFrame, config_id: str, set_name: str, min_trades: int) -> tuple[list, list]:
    if not len(bd):
        return [], []
    b = bd[(bd["config_id"] == config_id) & (bd["set"] == set_name) & (bd["dimension"] == "pair") & (bd["n"] >= min_trades)]
    good = b[b["expectancy_r"] > 0].sort_values("expectancy_r", ascending=False)
    bad = b[b["expectancy_r"] <= 0].sort_values("expectancy_r")
    fmt = lambda x: [f"{k} ({_r(e)}, {int(n)} trades)" for k, e, n in zip(x["key"], x["expectancy_r"], x["n"])]
    return fmt(good), fmt(bad)


CRIT_LABELS = {
    "c1": "≥ 100 trades", "c2": "espérance ≥ +0,10 R et PF ≥ 1,15", "c3": "borne basse IC 95 % > 0",
    "c4": "espérance > 0 avec coûts ×2", "c5": "au-dessus du 95e centile de la baseline aléatoire",
    "c6": "espérance > 0 sans la meilleure paire", "c7": "≥ 60 % des paires (≥ 10 trades) positives",
    "c8": "drawdown ≤ 25 %", "c9": "au plus 1 trimestre sur 3 sous −0,3 R",
}


def _final_verdict(entry: dict, val_row: dict | None, test_row: dict | None, unlocked: bool) -> tuple[str, str]:
    """(verdict, explanation) of a family."""
    if not entry["selected"]:
        if entry["val_verdict"] == "INSUFFISANT":
            return "INSUFFISANT", "aucune configuration n'atteint 100 trades sur DEV"
        return "REJETÉ", "aucune configuration ne passe DEV (≥ 100 trades, espérance > 0, PF > 1) avec le test de plateau"
    if val_row["verdict"] == "INSUFFISANT":
        return "INSUFFISANT", "moins de 100 trades sur VAL"
    if val_row["verdict"] != "PASSE":
        return "REJETÉ", "critères ratés sur VAL : " + ", ".join(str(val_row["criteria_failed"]).split(","))
    if not test_row:
        return "EN ATTENTE DU TEST", "les 9 critères sont remplis sur VAL ; TEST non encore ouvert"
    if test_row["verdict"] == "INSUFFISANT":
        return "INSUFFISANT", "moins de 100 trades sur TEST"
    if test_row["verdict"] != "PASSE":
        return "REJETÉ", "critères ratés sur TEST : " + ", ".join(str(test_row["criteria_failed"]).split(","))
    return "RETENU", "les 9 critères sont remplis sur VAL puis sur TEST"


def cmd_report(args) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    cfg = data.load_config()
    unlocked = bool(cfg["final_test_unlocked"])
    configs = setups.all_configs(cfg)
    by_id = {c["config_id"]: c for c in configs}
    dev, val, test = _read("summary_dev.csv"), _read("summary_val.csv"), _read("summary_test.csv")
    bd = pd.concat([x for x in (_read("breakdown_dev.csv"), _read("breakdown_val.csv"), _read("breakdown_test.csv"))
                    if len(x)], ignore_index=True)
    selection = json.loads((RESULTS / "selection.json").read_text())
    pairs = data.load_pairs()
    bh = _read("buy_hold.csv")
    excluded = json.loads((RESULTS / "excluded_pairs.json").read_text())["excluded"] if (RESULTS / "excluded_pairs.json").exists() else []
    trials = pd.read_csv(ROOT / "TRIALS.csv")
    n_trials = len(trials)
    n_cfg = trials["config_id"].nunique()
    test_done = len(test) > 0 or (unlocked and (RESULTS / "summary_test.csv").exists())

    fam_info, comp_rows, retained = {}, [], []
    for fam in sorted(cfg["families"]):
        entry = selection["families"][fam]
        cid = entry["selected"] or entry.get("best_dev_only")
        d_row = _row_of(dev, cid) if cid else None
        v_row = _row_of(val, cid) if cid else None
        t_row = _row_of(test, cid) if cid else None
        verdict, why = _final_verdict(entry, v_row, t_row, unlocked)
        if verdict == "EN ATTENTE DU TEST" and test_done:
            verdict, why = "REJETÉ", "non évalué sur TEST"
        fam_info[fam] = {"entry": entry, "cid": cid, "dev": d_row, "val": v_row, "test": t_row,
                         "verdict": verdict, "why": why}
        if cid:
            comp_rows.append({"family": fam, "config_id": cid, "dev": d_row, "val": v_row, "test": t_row})
        if verdict == "RETENU":
            retained.append(cid)

    # ---------------------------------------------------------------- charts
    charts = {}
    for fam, fi in fam_info.items():
        if fi["entry"]["selected"]:
            t = _read_trades(fi["cid"], "val")
            if len(t):
                charts[fam] = _plot_family(plt, fi["cid"], "VAL 2023-2024", t, cfg)
    comp = _plot_comparison(plt, comp_rows)

    # ---------------------------------------------------------------- REPORT.md
    n_pass_dev = int(dev["pass_dev"].sum())
    n_pass_plateau = int((dev["pass_dev"] & dev["pass_plateau"]).sum())
    survivors = [fi["cid"] for fi in fam_info.values() if fi["entry"]["survives_val"]]
    L: list[str] = ["# Rapport : validation de setups sur perpétuels Binance USDT-M", ""]
    L += ["## Résumé", ""]
    L += [f"- **{len(dev)} configurations** testées sur DEV (5 familles : A 64, B 16, C 8, D 8, E 4), "
          f"{len(pairs) - len(excluded)} paires, signaux 15m / 1h / 4h, moteur maison en résolution 15m.",
          f"- **{n_pass_dev}** passent DEV (≥ 100 trades, espérance > 0, PF > 1) ; **{n_pass_plateau}** passent aussi le test de plateau.",
          f"- **{len(val)}** évaluées telles quelles sur VAL ; une seule gardée par famille.",
          f"- **{len(survivors)}** configuration(s) remplissent les 9 critères sur VAL : {', '.join(survivors) if survivors else 'aucune'}.",
          (f"- TEST (2025-01-01 → {data.ms_to_ts(data.data_end_ms(cfg) - data.BAR_MS).strftime('%Y-%m-%d')}) ouvert une seule fois : "
           f"**{len(retained)} setup(s) RETENU(S)** : {', '.join(retained) if retained else 'aucun'}."
           if test_done else
           ("- TEST : **verrouillé**, pas encore ouvert." if survivors else
            "- TEST : **verrouillé**, jamais ouvert : aucune configuration ne survit à VAL, il n'y a rien à y évaluer.")),
          f"- Nombre total d'essais consignés dans `TRIALS.csv` : **{n_trials} lignes** pour **{n_cfg} configurations** "
          "(DEV, VAL, coûts ×2, TEST).",
          ("- **Verdict global : Aucun setup validé, scanner non construit.** Aucune des familles testées ne montre un edge "
           "qui résiste aux 9 critères."
           if not retained and (test_done or not survivors) else
           ("- **Verdict global : " + str(len(retained)) + " setup(s) validé(s)** selon les critères fixés à l'avance."
            if retained else "- Verdict global : en attente de l'ouverture du TEST.")),
          "- Tous les chiffres sont nets de frais (maker 0,02 %, taker 0,05 %), de slippage (0,03 %) et de funding réel.",
          ""]
    L += ["## Verdict par famille", ""]
    rows = []
    for fam, fi in fam_info.items():
        v = fi["val"]
        crit = ""
        if v and isinstance(v.get("verdict"), str):
            crit = " ".join(("✅" if v[c] else "❌") for c in metrics.CRITERIA)
        rows.append([f"**{fam}** {cfg['families'][fam]['name']}", f"`{fi['cid']}`" if fi["cid"] else "—",
                     _r(fi["dev"]["expectancy_r"]) + f" ({int(fi['dev']['n_trades'])})" if fi["dev"] else "—",
                     _r(v["expectancy_r"]) + f" ({int(v['n_trades'])})" if v else "non évalué",
                     crit or "—",
                     (_r(fi["test"]["expectancy_r"]) + f" ({int(fi['test']['n_trades'])})") if fi["test"] else "non évalué",
                     f"**{fi['verdict']}**"])
    L += [_table(["Famille", "Configuration gardée", "DEV : E[R] (trades)", "VAL : E[R] (trades)",
                  "Critères 1 à 9 sur VAL", "TEST : E[R] (trades)", "Verdict"], rows), ""]
    L += ["Critères, dans l'ordre : " + " ; ".join(f"{i + 1}. {CRIT_LABELS[c.split('_')[0]]}" for i, c in enumerate(metrics.CRITERIA)) + ".", ""]
    for fam, fi in fam_info.items():
        L.append(f"- **{fam}** : {fi['verdict']} — {fi['why']}.")
    L.append("")
    if comp:
        L += [f"![Comparaison des familles](results/{comp})", ""]

    for fam, fi in fam_info.items():
        entry = fi["entry"]
        grid = cfg["families"][fam]["grid"]
        L += [f"## Famille {fam} : {cfg['families'][fam]['name']}", "", "### Règles testées", "", _rules_text(cfg, fam), "",
              "Grille : " + " × ".join(f"{k} {{{', '.join(str(x) for x in v)}}}" for k, v in grid.items())
              + f" = **{entry['n_grid']} combinaisons**.", ""]
        d = dev[dev["family"] == fam]
        L += ["### Résultats DEV (2020-2022)", "",
              f"{entry['n_dev_with_100_trades']} configuration(s) sur {entry['n_grid']} ont au moins 100 trades ; "
              f"{entry['n_pass_dev']} passent DEV ; {entry['n_pass_dev_and_plateau']} passent DEV et le plateau. "
              f"Espérance médiane de la grille : {_r(d['expectancy_r'].median())} ; "
              f"{int((d['expectancy_r'] > 0).sum())} configuration(s) à espérance positive.", ""]
        rows = [[f"`{r['config_id']}`", int(r["n_trades"]), _n(100 * r["win_rate"], 1), _r(r["expectancy_r"]),
                 _n(r["profit_factor"]), _n(r["max_dd_pct"], 1), _n(r["baseline_percentile"], 0),
                 "oui" if r["pass_dev"] else "non", _n(r["plateau_share"]), "oui" if (r["pass_dev"] and r["pass_plateau"]) else "non"]
                for r in d.to_dict("records")]
        L += [_table(["Configuration", "Trades", "% gagnants", "E[R] net", "PF", "DD max %", "Centile baseline",
                      "Passe DEV", "Voisines > 0", "DEV + plateau"], rows,
                     ["---", "---:", "---:", "---:", "---:", "---:", "---:", ":-:", "---:", ":-:"]), ""]
        v = val[val["family"] == fam] if len(val) else val
        L += ["### Résultats VAL (2023-2024)", ""]
        if len(v):
            rows = [[f"`{r['config_id']}`", int(r["n_trades"]), _n(100 * r["win_rate"], 1), _r(r["expectancy_r"]),
                     f"[{_r(r['ci_low'])} ; {_r(r['ci_high'])}]", _n(r["profit_factor"]), _n(r["max_dd_pct"], 1),
                     _r(r["expectancy_costs_x2"]), _r(r["baseline_p95"]), "oui" if r["pass_plateau"] else "non",
                     r["verdict"], r["criteria_failed"] if isinstance(r["criteria_failed"], str) else ""]
                    for r in v.sort_values("expectancy_r", ascending=False).to_dict("records")]
            L += [_table(["Configuration", "Trades", "% gagnants", "E[R] net", "IC 95 %", "PF", "DD max %",
                          "E[R] coûts ×2", "95e centile baseline", "Plateau", "9 critères", "Critères ratés"], rows,
                         ["---", "---:", "---:", "---:", "---", "---:", "---:", "---:", "---:", ":-:", "---", "---"]), ""]
            L += ["« PASSE » = les 9 critères sont remplis sur VAL (condition nécessaire, pas suffisante : il faut aussi TEST).", ""]
        else:
            L += ["Aucune configuration de cette famille n'a passé DEV : rien n'a été évalué sur VAL.", ""]
        L += ["### Résultats TEST", ""]
        if fi["test"]:
            t = fi["test"]
            L += [f"`{fi['cid']}` : {_set_cell(t)}. Coûts ×2 : {_r(t['expectancy_costs_x2'])}. 95e centile de la baseline : "
                  f"{_r(t['baseline_p95'])}. Critères ratés : {t['criteria_failed'] if isinstance(t['criteria_failed'], str) and t['criteria_failed'] else 'aucun'}.", ""]
        else:
            L += ["Non évalué : " + ("aucune configuration de cette famille ne survit à VAL."
                                     if not entry["survives_val"] else "le jeu TEST est encore verrouillé."), ""]
        L += ["### Points forts et faiblesses chiffrés", ""]
        if fi["cid"] and (fi["val"] or fi["dev"]):
            ref_set = "val" if fi["val"] else "dev"
            m = fi[ref_set]
            b = bd[(bd["config_id"] == fi["cid"]) & (bd["set"] == ref_set)]
            lab = ref_set.upper()
            L.append(f"Configuration `{fi['cid']}`, chiffres {lab} :")
            L.append("")
            for dim, title in (("direction", "Par direction"), ("exit", "Par type de sortie")):
                x = b[b["dimension"] == dim]
                L.append(f"- {title} : " + " ; ".join(f"{k} {_r(e)} ({int(n)} trades)" for k, e, n in zip(x["key"], x["expectancy_r"], x["n"])) + ".")
            x = b[b["dimension"] == "pair"].sort_values("expectancy_r", ascending=False)
            if (x["n"] >= 10).any():            # same floor as criterion 7: a pair with a handful of trades says nothing
                x = x[x["n"] >= 10]
            if len(x):
                L.append(f"- Meilleure paire (≥ 10 trades) : {x.iloc[0]['key']} {_r(x.iloc[0]['expectancy_r'])} ({int(x.iloc[0]['n'])} trades) ; "
                         f"pire paire : {x.iloc[-1]['key']} {_r(x.iloc[-1]['expectancy_r'])} ({int(x.iloc[-1]['n'])} trades).")
            x = b[b["dimension"] == "quarter"].sort_values("key")
            if len(x):
                L.append("- Par trimestre : " + " ; ".join(f"{k} {_r(e)} ({int(n)})" for k, e, n in zip(x["key"], x["expectancy_r"], x["n"])) + ".")
            L.append(f"- Taux de réussite {_n(100 * m['win_rate'], 1)} %, R médian {_r(m['median_r'])}, plus longue série de pertes "
                     f"{int(m['longest_losing_streak'])}, drawdown max {_n(m['max_dd_pct'], 1)} % ({_n(m['max_dd_r'], 1)} R), "
                     f"Sharpe {_n(m['sharpe'])}, Calmar {_n(m['calmar'])}.")
            L.append(f"- {_n(m['trades_per_month'], 1)} trades par mois, détention moyenne {_n(m['avg_hold_hours'], 1)} h, "
                     f"{_n(m['time_in_position_pct'], 1)} % du temps en position.")
            share = m["cost_share_of_gross"]
            L.append(f"- Coûts (frais + slippage + funding) : {_n(m['costs_total'], 0)} USDT pour un PnL brut de {_n(m['gross_pnl'], 0)} USDT"
                     + (f", soit {_n(100 * share, 0)} % du brut." if np.isfinite(share) else " (brut négatif ou nul : les coûts s'ajoutent à la perte)."))
            L.append(f"- Baseline aléatoire : l'espérance observée est au {_n(m['baseline_percentile'], 0)}e centile des 1000 simulations "
                     f"(médiane {_r(m['baseline_median'])}, 95e centile {_r(m['baseline_p95'])}).")
            if fi["val"] and fi["dev"]:
                L.append(f"- Stabilité DEV → VAL : {_r(fi['dev']['expectancy_r'])} → {_r(fi['val']['expectancy_r'])}.")
            L.append("")
            if fam in charts:
                for name in charts[fam]:
                    L += [f"![{name}](results/{name})", ""]
        else:
            L += ["Aucune configuration exploitable.", ""]

    # ------------------------------------------------ context, limits
    L += ["## Contexte : buy & hold des paires (hors frais, à titre indicatif)", ""]
    if len(bh):
        piv_r = bh.pivot(index="symbol", columns="set", values="return_pct")
        piv_d = bh.pivot(index="symbol", columns="set", values="max_dd_pct")
        cols = [c for c in ("dev", "val", "test") if c in piv_r.columns]
        rows = [[sym] + [f"{_n(piv_r.loc[sym, c], 0)} % / −{_n(piv_d.loc[sym, c], 0)} %" if np.isfinite(piv_r.loc[sym, c]) else "pas de données"
                         for c in cols] for sym in piv_r.index]
        L += [_table(["Paire"] + [f"{c.upper()} : rendement / drawdown max" for c in cols], rows), ""]
    L += ["## Paires étudiées", "",
          _table(["Paire", "Mise en service (UTC)", "Volume moyen 90 j (USDT/jour)"],
                 [[p["symbol"], p["onboardDateUTC"][:10], _n(p["avg_daily_quote_volume_90d"], 0)] for p in pairs]), "",
          f"Paires exclues pour données manquantes (> 1 %) : {', '.join(excluded) if excluded else 'aucune'}. "
          "Détail dans `results/data_quality.md`.", ""]
    L += ["## Limites", "",
          "- **Biais de survie** : les 20 paires sont celles qui sont encore cotées et les plus échangées sur les 90 jours "
          "précédant le 2026-11-15. Les contrats disparus ou tombés dans l'oubli ne sont pas testés. Le classement par "
          "volume récent favorise des actifs devenus populaires **après** les périodes DEV et VAL : c'est une information "
          "du futur dans le choix de l'univers.",
          "- **Historiques inégaux** : chaque paire démarre à sa mise en service + 30 jours ; plusieurs paires n'existent "
          "pas en 2020-2021. DEV est donc dominé par les paires anciennes.",
          "- **Hypothèses de remplissage** : résolution 15m. Un ordre limite n'est rempli que si le prix traverse le niveau ; "
          "stop prioritaire sur l'objectif dans la même bougie ; pas d'objectif sur la bougie de remplissage d'un ordre limite. "
          "Ces choix sont prudents mais restent des hypothèses : pas de carnet d'ordres, pas de file d'attente, pas d'impact "
          "de marché, slippage fixe de 0,03 % même pendant les mouvements violents.",
          "- **Funding approximé** : appliqué sur le notionnel d'entrée (et non sur le prix de marque au moment du règlement), "
          "aux horodatages réels des archives Binance.",
          "- **Open interest non utilisé** (historique public limité à 30 jours).",
          f"- **Fin des données** : {data.ms_to_ts(data.data_end_ms(cfg) - data.BAR_MS).strftime('%Y-%m-%d %H:%M')} UTC. "
          "L'API Binance étant inaccessible depuis le serveur de recherche (HTTP 451), le mois en cours n'a pas pu être complété.",
          f"- **Nombre de configurations testées** : {n_cfg} configurations, {n_trials} évaluations au total. Avec autant "
          "d'essais, le hasard seul produit des résultats positifs sur DEV ; c'est la raison du plateau, de VAL et du TEST.",
          "- **Risque de sur-optimisation** : limité par des grilles fermées fixées avant tout résultat et par l'absence de "
          "réglage entre DEV, VAL et TEST, mais pas nul : les règles elles-mêmes (seuils 0,15 %, 1,5 ATR, etc.) sont des choix.",
          "- **Baseline aléatoire** : construite par tirage dans un réservoir d'entrées aléatoires, sans la contrainte des "
          "5 positions simultanées.",
          "- **Corrélation entre paires** : les trades simultanés sur plusieurs altcoins ne sont pas indépendants ; les "
          "intervalles de confiance par bootstrap des trades sont donc plus étroits que la réalité.",
          "- **Frais** : barème sans remise. Un compte avec remises ferait un peu mieux, un compte avec plus de slippage ferait pire.",
          ""]
    L += ["## Ce que ces résultats ne prouvent pas", "",
          "- Ils ne prouvent pas qu'un setup rejeté ne peut jamais fonctionner : seules les règles mécaniques écrites ici ont "
          "été testées. Le SMC discrétionnaire (lecture du contexte, sélection manuelle des niveaux) n'est pas reproduit par "
          "un algorithme de 64 variantes.",
          "- Ils ne prouvent pas qu'un setup retenu continuera de fonctionner : un edge mesuré sur le passé peut disparaître.",
          "- Ils ne disent rien des paires, timeframes, périodes ou marchés non testés.",
          "- Ils ne valident pas l'exécution réelle : latence, rejets d'ordres, liquidations en cascade, pannes d'exchange.",
          "- Un résultat positif sur DEV seul, ou sur une seule paire, ne vaut rien : c'est exactement ce que le hasard produit.",
          "", "Aucune performance future n'est promise ni suggérée par ce document.", ""]
    L += ["## Contrôles", ""]
    checks = RESULTS / "controles.md"
    L += [checks.read_text(encoding="utf-8") if checks.exists() else "_Section générée par `results/controles.md` (absente)._", ""]
    (ROOT / "REPORT.md").write_text("\n".join(L), encoding="utf-8")

    # ---------------------------------------------------------------- SETUPS_RETENUS.md
    S: list[str] = ["# Setups retenus", ""]
    if retained:
        S += [f"**{len(retained)} setup(s) ont le verdict RETENU** (9 critères remplis sur VAL puis sur TEST). "
              "Classement par espérance nette en R sur VAL.", ""]
    else:
        S += ["**Aucun setup n'a le verdict RETENU.** Aucune configuration ne remplit les 9 critères sur VAL puis sur TEST. "
              "Les fiches ci-dessous décrivent la meilleure configuration de chaque famille **à titre d'information "
              "uniquement** : elles portent toutes la mention **NON VALIDÉ** et ne doivent pas être tradées sur la base de "
              "ce rapport.", ""]
    order = sorted(fam_info.items(), key=lambda kv: -(kv[1]["val"]["expectancy_r"] if kv[1]["val"] else -9e9))
    for fam, fi in order:
        if not fi["cid"]:
            S += [f"## Famille {fam} : {cfg['families'][fam]['name']} — NON VALIDÉ", "",
                  "Aucune configuration exploitable (pas assez de trades).", ""]
            continue
        if retained and fi["verdict"] != "RETENU":
            continue
        config = by_id[fi["cid"]]
        tf = setups.timeframe_of(cfg, config)
        tag = "RETENU" if fi["verdict"] == "RETENU" else f"NON VALIDÉ ({fi['verdict']})"
        S += [f"## {cfg['families'][fam]['name']} — `{fi['cid']}` — {tag}", "",
              f"Famille {fam}. Motif du verdict : {fi['why']}.", "", "### Règles", ""]
        S += [f"{i + 1}. {step}" for i, step in enumerate(_describe_config(cfg, config))]
        S += ["", "Dans tous les cas : signal ignoré si la distance au stop est inférieure à 0,3 % ou supérieure à 6 % du "
              "prix d'entrée ; 1 % du capital risqué par trade ; une seule position par paire, 5 au total.", "",
              "### Résultats (nets de frais, slippage et funding)", "",
              _table(["Jeu", "Trades", "Espérance nette [IC 95 %]", "PF", "% gagnants", "Drawdown max", "Rendement (info)"],
                     [[name.upper(),
                       int(m["n_trades"]) if m else "—",
                       (f"{_r(m['expectancy_r'])} [{_r(m['ci_low'])} ; {_r(m['ci_high'])}]" if m and m["n_trades"] else "non évalué" if not m else "—"),
                       _n(m["profit_factor"]) if m and m["n_trades"] else "—",
                       _n(100 * m["win_rate"], 1) + " %" if m and m["n_trades"] else "—",
                       _n(m["max_dd_pct"], 1) + " %" if m and m["n_trades"] else "—",
                       _n(m["total_return_pct"], 1) + " %" if m and m["n_trades"] else "—"]
                      for name, m in (("dev", fi["dev"]), ("val", fi["val"]), ("test", fi["test"]))]), ""]
        ref_set = "val" if fi["val"] else "dev"
        good, bad = _pair_lists(bd, fi["cid"], ref_set, cfg["verdict"]["min_trades_per_pair"])
        S += [f"### Paires ({ref_set.upper()}, au moins {cfg['verdict']['min_trades_per_pair']} trades)", "",
              "- Espérance positive : " + (", ".join(good) if good else "aucune") + ".",
              "- Espérance négative ou nulle : " + (", ".join(bad) if bad else "aucune") + ".", ""]
        t = _read_trades(fi["cid"], ref_set)
        S += ["### Exemples de trades (bougies réelles)", ""]
        if len(t):
            for label, sub, tag2 in (("Exemple gagnant", t[t["r_multiple_net"] > 0], "gagnant"),
                                     ("Exemple perdant", t[t["r_multiple_net"] < 0], "perdant")):
                if not len(sub):
                    S += [f"{label} : aucun sur {ref_set.upper()}.", ""]
                    continue
                med = sub["r_multiple_net"].median()
                pick = sub.iloc[(sub["r_multiple_net"] - med).abs().argsort(kind="stable").iloc[0]]
                name = _plot_trade(plt, cfg, pick, tf, label, f"exemple_{tag2}_{fi['cid']}.png")
                if name:
                    S += [f"![{label}](results/{name})", "",
                          f"{label} (trade médian parmi les {tag2}s de {ref_set.upper()}) : {pick['symbole']} {pick['direction']}, "
                          f"entrée {pick['entry_time'].strftime('%Y-%m-%d %H:%M')} UTC à {pick['entry_price']:.6g}, stop {pick['stop_price']:.6g}, "
                          f"sortie {pick['exit_time'].strftime('%Y-%m-%d %H:%M')} UTC à {pick['exit_price']:.6g} ({pick['exit_reason']}), "
                          f"résultat {_r(pick['r_multiple_net'])}.", ""]
        else:
            S += ["Aucun trade à illustrer.", ""]
        m = fi[ref_set]
        b = bd[(bd["config_id"] == fi["cid"]) & (bd["set"].isin(["dev", "val", "test"])) & (bd["dimension"] == "quarter")]
        S += ["### Limites", ""]
        if len(b):
            worst = b.sort_values("expectancy_r").iloc[0]
            S.append(f"- Pire trimestre : {worst['key']} ({worst['set'].upper()}), {_r(worst['expectancy_r'])} sur {int(worst['n'])} trades.")
        if fi["val"]:
            S.append(f"- Sensibilité aux frais : sur VAL l'espérance passe de {_r(fi['val']['expectancy_r'])} à "
                     f"{_r(fi['val']['expectancy_costs_x2'])} avec frais et slippage doublés.")
        share = m["cost_share_of_gross"] if m else float("nan")
        if m:
            S.append(f"- Coûts sur {ref_set.upper()} : {_n(m['costs_total'], 0)} USDT pour {_n(m['gross_pnl'], 0)} USDT de PnL brut"
                     + (f" ({_n(100 * share, 0)} % du brut)." if np.isfinite(share) else "."))
        if fi["verdict"] != "RETENU":
            crit = fi["val"]["criteria_failed"] if fi["val"] and isinstance(fi["val"]["criteria_failed"], str) else ""
            if crit:
                S.append("- Critères ratés sur VAL : " + " ; ".join(CRIT_LABELS[c] for c in crit.split(",") if c in CRIT_LABELS) + ".")
        S += ["", "Signal issu d'un backtest, aucune garantie de résultat.", ""]
    (ROOT / "SETUPS_RETENUS.md").write_text("\n".join(S), encoding="utf-8")
    if test_done and not retained:
        log("report: no retained setup -> scanner not built")
    log(f"report written: REPORT.md, SETUPS_RETENUS.md, {sum(len(v) for v in charts.values())} family charts")


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
