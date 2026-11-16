"""Study 4: comparative backtest of seven methods on 15m and 1h (see PROTOCOLE_ETUDE_4.md).

    python -m src.etude4 run      training + validation, selection, criteria, walk-forward
    python -m src.etude4 test     single final test on the finalists (needs final_test_unlocked: true)
    python -m src.etude4 report   rapport.md and its charts
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd

from . import data, methods, metrics, run, setups  # noqa: F401  (methods registers M1..M7)

STUDY = "etude4"
PARAM = {"M1": "sweep_n", "M2": "donchian_n", "M3": "ema_pullback", "M4": "rsi_low", "M5": "vwap_k",
         "M6": "z", "M7": "vol_mult"}
CRITERIA = ["c1_trades", "c2_expectancy", "c3_profit_factor", "c4_drawdown", "c5_pairs", "c6_monte_carlo",
            "c7_baseline", "c8_buy_hold"]


def setup() -> dict:
    """Point the shared machinery at this study's configuration and output folder."""
    data.OVERLAY_PATH = data.ROOT / "config" / f"{STUDY}.yaml"
    run.RESULTS = data.ROOT / f"results_{STUDY}"
    run.LOG_PATH = run.RESULTS / "run_log.txt"
    run.TRIALS_PATH = data.ROOT / f"TRIALS_{STUDY}.csv"
    return data.load_config()


def load(cfg: dict) -> list[dict]:
    symbols = [p["symbol"] for p in data.load_pairs()]
    market, ctxs = run.load_market(cfg, symbols)
    configs = setups.all_configs(cfg)
    run._G.update(cfg=cfg, market=market, ctxs=ctxs, configs=configs)
    last = max(int(sd.ot[-1]) for sd in market.values())
    run.log(f"{STUDY}: {len(market)} pairs loaded, last candle in memory {data.ms_to_ts(last)}, "
            f"final_test_unlocked={cfg['final_test_unlocked']}")
    return configs


def read_trades(config_id: str, set_name: str) -> pd.DataFrame:
    t = pd.read_csv(run.trades_path(config_id, set_name))
    t["entry_ms"] = pd.to_datetime(t["entry_time"], utc=True).astype("int64") // 1_000_000 if len(t) else []
    return t


# ---------------------------------------------------------------- buy & hold basket

def buy_hold_basket(market: dict, start_ms: int, end_ms: int) -> dict:
    """Equal-weight basket of the pairs already trading at the start of the period, held to the end."""
    cols = {}
    for sym, sd in sorted(market.items()):
        mask = (sd.ot >= start_ms) & (sd.ot < end_ms)
        if not mask.any() or sd.ot[mask][0] - start_ms > 86_400_000:      # not trading yet at the start
            continue
        day = sd.ot[mask] // 86_400_000
        last = np.r_[day[1:] != day[:-1], True]
        cols[sym] = pd.Series(sd.c[mask][last], index=day[last])
    if not cols:
        return {"return_pct": float("nan"), "max_dd_pct": float("nan"), "ratio": float("nan"), "n_pairs": 0}
    frame = pd.DataFrame(cols).sort_index().ffill()
    frame = frame.loc[:, frame.iloc[0].notna()]
    curve = (frame / frame.iloc[0]).mean(axis=1).to_numpy()
    ret = 100.0 * (curve[-1] - 1.0)
    dd = 100.0 * float(((np.maximum.accumulate(curve) - curve) / np.maximum.accumulate(curve)).max())
    return {"return_pct": float(ret), "max_dd_pct": dd, "ratio": float(ret / dd) if dd > 0 else float("inf"),
            "n_pairs": int(frame.shape[1])}


# ---------------------------------------------------------------- criteria

def monte_carlo(r: np.ndarray, risk: float, n_sims: int, rng: np.random.Generator) -> dict:
    """Bootstrap of the trades (share of positive totals) and reshuffle of their order (drawdown spread)."""
    n = len(r)
    if n == 0:
        return {"mc_share_positive": float("nan"), "mc_dd_p95_pct": float("nan")}
    chunk = max(1, 4_000_000 // n)
    positive, done = 0, 0
    while done < n_sims:
        m = min(chunk, n_sims - done)
        positive += int((r[rng.integers(0, n, size=(m, n))].sum(axis=1) > 0).sum())
        done += m
    dds = np.empty(2000)
    growth = 1.0 + risk * r
    for i in range(len(dds)):
        eq = np.cumprod(rng.permutation(growth))
        peak = np.maximum.accumulate(np.r_[1.0, eq])[1:]
        dds[i] = float(((peak - eq) / peak).max())
    return {"mc_share_positive": positive / n_sims, "mc_dd_p95_pct": 100.0 * float(np.quantile(dds, 0.95))}


def assess(trades: pd.DataFrame, row: dict, cfg: dict, bh: dict, rng: np.random.Generator) -> dict:
    """The eight per-period criteria of the protocol (stability is assessed separately)."""
    cr = cfg[STUDY]["criteria"]
    r = trades["r_multiple_net"].to_numpy(dtype="float64")
    by_pair = trades.groupby("symbole")["r_multiple_net"].agg(["count", "sum"]) if len(trades) else pd.DataFrame(columns=["count", "sum"])
    elig = by_pair[by_pair["count"] >= cr["pair_min_trades"]]
    share = float((elig["sum"] > 0).mean()) if len(elig) else 0.0
    mc = monte_carlo(r, cfg["engine"]["risk_per_trade"], int(cr["monte_carlo_resamples"]), rng)
    dd = float(row["max_dd_pct"]) if len(r) else float("nan")
    ratio = float(row["total_return_pct"]) / dd if len(r) and dd > 0 else float("nan")
    out = {"share_pairs_positive": share, "pairs_counted": int(len(elig)), **mc,
           "return_over_dd": ratio, "bh_return_pct": bh["return_pct"], "bh_max_dd_pct": bh["max_dd_pct"],
           "bh_return_over_dd": bh["ratio"]}
    out["c1_trades"] = bool(len(r) >= cr["min_trades"])
    out["c2_expectancy"] = bool(len(r) and row["expectancy_r"] > cr["min_expectancy_r"])
    out["c3_profit_factor"] = bool(len(r) and row["profit_factor"] > cr["min_profit_factor"])
    out["c4_drawdown"] = bool(len(r) and dd < cr["max_drawdown_pct"])
    out["c5_pairs"] = bool(share >= cr["min_share_pairs_positive"])
    out["c6_monte_carlo"] = bool(len(r) and mc["mc_share_positive"] >= cr["monte_carlo_min_positive"])
    out["c7_baseline"] = bool(len(r) and np.isfinite(row["baseline_p95"]) and row["expectancy_r"] > row["baseline_p95"])
    out["c8_buy_hold"] = bool(len(r) and np.isfinite(ratio) and ratio > bh["ratio"])
    out["criteria_failed"] = ",".join(c.split("_")[0] for c in CRITERIA if not out[c])
    out["all_passed"] = not out["criteria_failed"]
    return out


# ---------------------------------------------------------------- walk-forward

def walk_forward(cfg: dict, configs: list[dict], trades: dict) -> pd.DataFrame:
    """Per method and window: pick the variant with the best past expectancy, measure it on the window."""
    rows = []
    min_n = cfg[STUDY]["train_min_trades"]
    for fam in sorted({c["family"] for c in configs}):
        variants = [c["config_id"] for c in configs if c["family"] == fam]
        for k, w in enumerate(cfg[STUDY]["walk_forward"], 1):
            a = data.to_ms(w["start"])
            z = data.to_ms(pd.Timestamp(w["end"]) + pd.Timedelta(days=1))
            best, best_e = None, -np.inf
            for cid in variants:
                past = trades[cid][trades[cid]["entry_ms"] < a]["r_multiple_net"]
                if len(past) >= min_n and past.mean() > best_e:
                    best, best_e = cid, float(past.mean())
            if best is None:
                rows.append({"family": fam, "window": k, "start": w["start"], "end": w["end"], "chosen": "",
                             "past_expectancy_r": float("nan"), "n_trades": 0, "sum_r": 0.0, "expectancy_r": float("nan")})
                continue
            t = trades[best]
            oos = t[(t["entry_ms"] >= a) & (t["entry_ms"] < z)]["r_multiple_net"]
            rows.append({"family": fam, "window": k, "start": w["start"], "end": w["end"], "chosen": best,
                         "past_expectancy_r": best_e, "n_trades": int(len(oos)), "sum_r": float(oos.sum()),
                         "expectancy_r": float(oos.mean()) if len(oos) else float("nan")})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- stability (+/- 20 %)

def shifted_configs(cfg: dict, config: dict, first_index: int) -> list[dict]:
    fam, shift = config["family"], cfg[STUDY]["criteria"]["stability_shift"]
    base = dict(config["params"])
    base.setdefault("sl_atr", cfg["families"][fam]["fixed"]["sl_atr"])
    out = []
    for key in (PARAM[fam], "sl_atr", "tp_r"):
        for factor in (1.0 - shift, 1.0 + shift):
            params = dict(base)
            params[key] = round(float(base[key]) * factor, 6)
            tag = f"{setups._ALIAS[key]}{setups._fmt(params[key])}"
            out.append({"family": fam, "config_id": f"{config['config_id']}__{tag}", "params": params,
                        "index": first_index + len(out), "shifted": key})
    return out


# ---------------------------------------------------------------- commands

def cmd_run(args) -> None:
    cfg = setup()
    run.check_sets_allowed(cfg, ["dev", "val"])
    configs = load(cfg)
    market = run._G["market"]
    res = {s: run._run_tasks([(c["index"], s, False) for c in configs], args.workers) for s in ("dev", "val")}
    summ = {s: pd.DataFrame([r["row"] for r in res[s]]) for s in res}
    for s in summ:
        summ[s].to_csv(run.RESULTS / f"summary_{s}.csv", index=False, float_format="%.6g")
        run._save_breakdowns(res[s], s)
    run.log(f"training and validation done: {len(configs)} variants")
    bounds = {s: data.set_bounds_ms(cfg, s) for s in ("dev", "val")}
    bh = {s: buy_hold_basket(market, *bounds[s]) for s in bounds}
    dev, val = summ["dev"].set_index("config_id"), summ["val"].set_index("config_id")
    trades = {c["config_id"]: pd.concat([read_trades(c["config_id"], "dev"), read_trades(c["config_id"], "val")],
                                        ignore_index=True) for c in configs}
    wf = walk_forward(cfg, configs, trades)
    wf.to_csv(run.RESULTS / "walkforward.csv", index=False, float_format="%.6g")

    selection = {"buy_hold": bh, "methods": {}, "n_variants": len(configs)}
    for fam in sorted(cfg["families"]):
        d = dev[dev["family"] == fam]
        ok = d[d["n_trades"] >= cfg[STUDY]["train_min_trades"]]
        entry = {"name": cfg["families"][fam]["name"], "n_variants": int(len(d)),
                 "n_variants_min_trades": int(len(ok)), "n_variants_positive_train": int((d["expectancy_r"] > 0).sum())}
        w = wf[wf["family"] == fam]
        entry["walk_forward"] = {"n_trades": int(w["n_trades"].sum()),
                                 "expectancy_r": float(w["sum_r"].sum() / w["n_trades"].sum()) if w["n_trades"].sum() else float("nan"),
                                 "windows_positive": int((w["sum_r"] > 0).sum()), "windows": int(len(w))}
        if len(ok) == 0:
            entry.update(selected=None, status="INSUFFISANT")
            selection["methods"][fam] = entry
            continue
        cid = ok["expectancy_r"].idxmax()
        idx = next(c["index"] for c in configs if c["config_id"] == cid)
        crit = assess(read_trades(cid, "val"), val.loc[cid].to_dict(), cfg, bh["val"],
                      np.random.default_rng([cfg["seed"], idx, 41]))
        entry.update(selected=cid, validation=crit)
        selection["methods"][fam] = entry

    # stability, only for the methods that meet every validation criterion
    stab_rows = []
    extra = list(configs)
    for fam, entry in selection["methods"].items():
        if not entry.get("selected") or not entry["validation"]["all_passed"]:
            continue
        base = next(c for c in configs if c["config_id"] == entry["selected"])
        shifted = shifted_configs(cfg, base, len(extra))
        extra += shifted
        run._G["configs"] = extra
        for s in ("dev", "val"):
            for r in run._run_tasks([(c["index"], s, False) for c in shifted], args.workers):
                stab_rows.append(r["row"])
        results = []
        for c in shifted:
            t = pd.concat([read_trades(c["config_id"], "dev"), read_trades(c["config_id"], "val")])
            results.append({"config_id": c["config_id"], "shifted": c["shifted"], "n_trades": int(len(t)),
                            "expectancy_r": float(t["r_multiple_net"].mean()) if len(t) else float("nan")})
        entry["stability"] = {"variants": results, "passed": bool(all(x["expectancy_r"] > 0 for x in results))}
    pd.DataFrame(stab_rows).to_csv(run.RESULTS / "summary_stability.csv", index=False, float_format="%.6g")

    passing = [(f, e) for f, e in selection["methods"].items()
               if e.get("selected") and e["validation"]["all_passed"] and e.get("stability", {}).get("passed")]
    passing.sort(key=lambda fe: -float(val.loc[fe[1]["selected"], "expectancy_r"]))
    selection["finalists"] = [e["selected"] for _, e in passing[: cfg[STUDY]["max_finalists"]]]
    selection["n_shifted_variants"] = len(extra) - len(configs)
    (run.RESULTS / "selection.json").write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
    write_trials()
    run.log(f"selection done: finalists = {selection['finalists'] or 'none'}; "
            f"{len(configs)} variants + {selection['n_shifted_variants']} shifted")


def write_trials() -> None:
    frames = []
    for name in ("summary_dev.csv", "summary_val.csv", "summary_stability.csv", "summary_test.csv"):
        p = run.RESULTS / name
        if p.exists() and p.stat().st_size > 5:
            frames.append(pd.read_csv(p)[run.TRIAL_COLS])
    pd.concat(frames, ignore_index=True).to_csv(run.TRIALS_PATH, index=False, float_format="%.6g")


def cmd_test(args) -> None:
    cfg = setup()
    run.check_sets_allowed(cfg, ["test"])                 # raises while the final test is locked
    if (run.RESULTS / "summary_test.csv").exists():
        raise RuntimeError("summary_test.csv already exists: the final test is run only once.")
    selection = json.loads((run.RESULTS / "selection.json").read_text())
    if not selection["finalists"]:
        raise RuntimeError("no finalist: the final test must not be opened.")
    configs = load(cfg)
    todo = [c for c in configs if c["config_id"] in selection["finalists"]]
    run.log(f"FINAL TEST on {[c['config_id'] for c in todo]}")
    res = run._run_tasks([(c["index"], "test", False) for c in todo], args.workers)
    test = pd.DataFrame([r["row"] for r in res])
    test.to_csv(run.RESULTS / "summary_test.csv", index=False, float_format="%.6g")
    run._save_breakdowns(res, "test")
    bh = buy_hold_basket(run._G["market"], *data.set_bounds_ms(cfg, "test"))
    selection["buy_hold"]["test"] = bh
    retained = []
    for c, row in zip(todo, test.to_dict("records")):
        crit = assess(read_trades(c["config_id"], "test"), row, cfg, bh, np.random.default_rng([cfg["seed"], c["index"], 43]))
        selection["methods"][c["family"]]["test"] = crit
        if crit["all_passed"]:
            retained.append(c["config_id"])
    selection["retained"] = retained
    (run.RESULTS / "selection.json").write_text(json.dumps(selection, indent=2) + "\n", encoding="utf-8")
    write_trials()
    run.log(f"FINAL TEST done: retained = {retained or 'none'}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m src.etude4")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("run", "test"):
        sp = sub.add_parser(name)
        sp.add_argument("--workers", type=int, default=4)
    sub.add_parser("report")
    args = parser.parse_args(argv)
    if args.cmd == "report":
        from . import etude4_report
        etude4_report.build()
    else:
        {"run": cmd_run, "test": cmd_test}[args.cmd](args)


if __name__ == "__main__":
    main(sys.argv[1:])
