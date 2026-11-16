"""Study 5: a model retrained every month scores the momentum 1h signals (see PROTOCOLE_ETUDE_5.md).

    python -m src.etude5 run      candidates, out-of-sample scores, training + validation, verdict
"""
from __future__ import annotations

import argparse
import json
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

from . import data, engine, etude4, indicators as ind, methods, metrics, run, setups  # noqa: F401

STUDY = "etude5"
HOUR = 3_600_000
FEATURES = ["vol_ratio", "body_atr", "break_atr", "atr_pct", "adx", "rsi_dir", "ema200_dist_dir", "ema_slope_dir",
            "trend_4h_dir", "ret_24h_dir", "ret_7d_dir", "range_pos_dir", "funding_dir", "funding_z_dir",
            "btc_ret_24h_dir", "btc_atr_pct", "hour_sin", "hour_cos", "weekday"]


def setup() -> dict:
    data.OVERLAY_PATH = data.ROOT / "config" / f"{STUDY}.yaml"
    run.RESULTS = data.ROOT / f"results_{STUDY}"
    run.LOG_PATH = run.RESULTS / "run_log.txt"
    run.TRIALS_PATH = data.ROOT / f"TRIALS_{STUDY}.csv"
    return data.load_config()


# ---------------------------------------------------------------- features (closed candles only)

def _ret(c: np.ndarray, n: int) -> np.ndarray:
    out = np.full(len(c), np.nan)
    if len(c) > n:
        out[n:] = c[n:] / c[:-n] - 1.0
    return out


def features_for(ctx: setups.SymbolContext, btc: setups.SymbolContext, sig: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """One row of features per signal of ``ctx``; every value is known at the close of the signal candle."""
    b, b4, bb = ctx.bars["1h"], ctx.bars["4h"], btc.bars["1h"]
    t = np.searchsorted(b.ct, sig["order_time"].to_numpy(dtype="int64"))
    d = sig["direction"].to_numpy(dtype="float64")
    atr, c = b.atr, b.c
    with np.errstate(divide="ignore", invalid="ignore"):
        vr = b.v / ind.rolling_mean_prev(b.v, 20)
        vr3 = np.maximum.reduce([vr, np.r_[np.nan, vr[:-1]], np.r_[np.nan, np.nan, vr[:-2]], np.r_[[np.nan] * 3, vr[:-3]]])
        hi3, lo3 = ind.rolling_max_prev(b.h, 3), ind.rolling_min_prev(b.l, 3)
        hi20, lo20 = ind.donchian(b.h, b.l, 20)
        trend4 = np.sign(data.align_htf(b.ct, b4.ct, b4.ema(50) - b4.ema(200)))
        fz = setups.funding_zscore(ctx.f_rate, 90)
        k = np.searchsorted(ctx.f_time, b.ct[t], side="right") - 1          # last settlement at or before the close
        ok = k >= 0
        f_rate = np.where(ok, ctx.f_rate[np.maximum(k, 0)] if len(ctx.f_rate) else np.nan, np.nan)
        f_z = np.where(ok, fz[np.maximum(k, 0)] if len(fz) else np.nan, np.nan)
        j = np.searchsorted(bb.ct, b.ct[t], side="right") - 1                # last BTC candle closed by then
        okb = j >= 0
        btc_ret = np.where(okb, _ret(bb.c, 24)[np.maximum(j, 0)], np.nan)
        btc_vol = np.where(okb, (bb.atr / bb.c)[np.maximum(j, 0)], np.nan)
        hour = (b.ct[t] // HOUR) % 24
        out = pd.DataFrame({
            "vol_ratio": vr3[t],
            "body_atr": np.abs(c[t] - b.o[t]) / atr[t],
            "break_atr": np.where(d > 0, c[t] - hi3[t], lo3[t] - c[t]) / atr[t],
            "atr_pct": atr[t] / c[t],
            "adx": b.adx[t],
            "rsi_dir": np.where(d > 0, b.rsi[t], 100.0 - b.rsi[t]),
            "ema200_dist_dir": d * (c[t] - b.ema(200)[t]) / atr[t],
            "ema_slope_dir": d * (b.ema(20)[t] - b.ema(50)[t]) / atr[t],
            "trend_4h_dir": d * trend4[t],
            "ret_24h_dir": d * _ret(c, 24)[t],
            "ret_7d_dir": d * _ret(c, 168)[t],
            "range_pos_dir": np.where(d > 0, (c[t] - lo20[t]) / (hi20[t] - lo20[t]), (hi20[t] - c[t]) / (hi20[t] - lo20[t])),
            "funding_dir": d * f_rate,
            "funding_z_dir": d * f_z,
            "btc_ret_24h_dir": d * btc_ret,
            "btc_atr_pct": btc_vol,
            "hour_sin": np.sin(2 * np.pi * hour / 24.0),
            "hour_cos": np.cos(2 * np.pi * hour / 24.0),
            "weekday": ((b.ct[t] // (24 * HOUR)) + 4) % 7,                   # 0 = Monday
        })
    return out.replace([np.inf, -np.inf], np.nan)[FEATURES]


def standalone_outcomes(sig: pd.DataFrame, market: dict, cfg: dict, end_ms: int) -> pd.DataFrame:
    """Net R and exit time of every signal simulated alone (no portfolio limit), same costs as the backtests."""
    rows = []
    for i in range(len(sig)):
        one = sig.iloc[i:i + 1]
        sym = one["symbol"].iloc[0]
        tr, _ = engine.run_backtest(one, {sym: market[sym]}, cfg, int(one["order_time"].iloc[0]), end_ms, "M7", "standalone")
        if len(tr) == 1:
            exit_ms = (pd.Timestamp(tr["exit_time"].iloc[0]) - pd.Timestamp(0, tz="UTC")) // pd.Timedelta(milliseconds=1)
            rows.append((i, float(tr["r_multiple_net"].iloc[0]), int(exit_ms)))
    out = pd.DataFrame(rows, columns=["i", "r", "exit_ms"]).set_index("i")
    return out


# ---------------------------------------------------------------- monthly retraining, out-of-sample scores

def month_starts(first_ms: int, last_ms: int) -> list[int]:
    p = pd.Timestamp(first_ms, unit="ms", tz="UTC").tz_localize(None).to_period("M")
    out = []
    while data.to_ms(p.start_time) <= last_ms:
        out.append(data.to_ms(p.start_time))
        p += 1
    return out


def oos_scores(cands: pd.DataFrame, params: dict, min_history_months: int, seed: int) -> np.ndarray:
    """Score of each candidate from the model trained at the start of its month on trades already closed."""
    scores = np.full(len(cands), np.nan)
    if not len(cands):
        return scores
    t, x_ms = cands["order_time"].to_numpy(), cands["exit_ms"].to_numpy()
    X, y = cands[FEATURES].to_numpy(dtype="float64"), (cands["r"].to_numpy() > 0).astype(int)
    starts = month_starts(int(t.min()), int(t.max()))
    for k, start in enumerate(starts):
        if k < min_history_months:
            continue
        nxt = starts[k + 1] if k + 1 < len(starts) else np.iinfo("int64").max
        train = x_ms < start                                   # outcome known before the month begins
        todo = (t >= start) & (t < nxt)
        if not todo.any() or train.sum() < 500 or len(np.unique(y[train])) < 2:
            continue
        model = HistGradientBoostingClassifier(random_state=seed, early_stopping=False, **params)
        model.fit(X[train], y[train])
        scores[todo] = model.predict_proba(X[todo])[:, 1]
    return scores


def keep_mask(cands: pd.DataFrame, q: float, lookback_months: int) -> np.ndarray:
    """Keep a candidate when its score reaches the q-quantile of the scores of the previous months."""
    t, s = cands["order_time"].to_numpy(), cands["score"].to_numpy()
    keep = np.zeros(len(cands), dtype=bool)
    if not len(cands):
        return keep
    starts = month_starts(int(t.min()), int(t.max()))
    for k, start in enumerate(starts):
        if k < lookback_months:
            continue
        nxt = starts[k + 1] if k + 1 < len(starts) else np.iinfo("int64").max
        past = s[(t >= starts[k - lookback_months]) & (t < start)]
        if np.isnan(past).any() or len(past) < 50:              # a full window of out-of-sample scores is required
            continue
        todo = (t >= start) & (t < nxt)
        keep[todo] = s[todo] >= np.quantile(past, q)
    return keep


# ---------------------------------------------------------------- evaluation through the engine

def evaluate(sig: pd.DataFrame, label: str, set_name: str, start_ms: int, end_ms: int, cfg: dict, market: dict,
             ctxs: dict, config: dict, bh: dict, seed_tag: int) -> dict:
    trades, info = engine.run_backtest(sig, market, cfg, start_ms, end_ms, "M7", label)
    trades.to_csv(run.RESULTS / f"trades_{label}_{set_name}.csv", index=False, float_format="%.10g")
    rng = np.random.default_rng([cfg["seed"], seed_tag, run.SET_INDEX[set_name]])
    m = metrics.compute_metrics(trades, cfg, start_ms, end_ms, rng)
    base = run.baseline_distribution(market, ctxs, cfg, dict(config, index=seed_tag), trades, info, start_ms, end_ms,
                                     set_name=set_name)
    row = {"variant": label, "set": set_name, **m,
           "baseline_p95": float(np.quantile(base, 0.95)) if len(base) else float("nan")}
    row.update(etude4.assess(trades, row, cfg, bh, rng))
    return row


def build_candidates(cfg: dict, market: dict, ctxs: dict, config: dict) -> pd.DataFrame:
    sig = run.get_signals(cfg, ctxs, config).reset_index(drop=True)
    out = standalone_outcomes(sig, market, cfg, data.max_readable_ms(cfg))
    feats = pd.concat([features_for(ctxs[sym], ctxs["BTCUSDT"], g, cfg).set_index(g.index)
                       for sym, g in sig.groupby("symbol", sort=True)]).sort_index()
    cands = pd.concat([sig, feats], axis=1).join(out, how="inner").reset_index(drop=True)
    return cands.sort_values(["order_time", "symbol"], kind="stable").reset_index(drop=True)


def cmd_run(args) -> None:
    cfg = setup()
    run.check_sets_allowed(cfg, ["dev", "val"])
    configs = etude4.load(cfg)
    market, ctxs, config, st = run._G["market"], run._G["ctxs"], configs[0], cfg[STUDY]
    assert config["config_id"] == st["candidates"], config["config_id"]
    cands = build_candidates(cfg, market, ctxs, config)
    cands["score"] = oos_scores(cands, st["model"], st["min_history_months"], cfg["seed"])
    cands.to_csv(run.RESULTS / "candidates.csv", index=False, float_format="%.8g")
    run.log(f"{len(cands)} candidates, {int(cands['score'].notna().sum())} scored out of sample")

    first = data.to_ms(st["first_trading_day"])
    bounds = {"dev": (max(first, data.set_bounds_ms(cfg, "dev")[0]), data.set_bounds_ms(cfg, "dev")[1]),
              "val": data.set_bounds_ms(cfg, "val")}
    bh = {s: etude4.buy_hold_basket(market, *bounds[s]) for s in bounds}
    sig_cols = engine.SIGNAL_COLUMNS
    variants = {"sans_modele_v2": cands[sig_cols]}
    ref_cfg = {"family": "M7", "config_id": st["unfiltered_reference"], "params": {"timeframe": "1h", "vol_mult": 3, "tp_r": 2.5}}
    variants["sans_modele_v3"] = pd.concat([setups.generate_signals(ctxs[s], ref_cfg) for s in sorted(ctxs)], ignore_index=True)
    masks = {}
    for q in st["keep_quantiles"]:
        masks[q] = keep_mask(cands, q, st["threshold_lookback_months"])
        variants[f"modele_top{int(round(100 * (1 - q)))}"] = cands.loc[masks[q], sig_cols]
    rows = []
    for n, (label, sig) in enumerate(variants.items()):
        for s in ("dev", "val"):
            rows.append(evaluate(sig, label, s, *bounds[s], cfg, market, ctxs, config, bh[s], 500 + n))
    summ = pd.DataFrame(rows)
    summ.to_csv(run.RESULTS / "summary.csv", index=False, float_format="%.6g")

    # choice on training, then the two questions on validation
    dev = summ[(summ["set"] == "dev") & summ["variant"].str.startswith("modele") & (summ["n_trades"] >= cfg["etude4"]["train_min_trades"])]
    val = summ[summ["set"] == "val"].set_index("variant")
    result = {"n_candidates": int(len(cands)), "bounds": {k: [str(data.ms_to_ts(a)), str(data.ms_to_ts(b))] for k, (a, b) in bounds.items()},
              "buy_hold": bh, "variants_tested": len(st["keep_quantiles"])}
    if len(dev):
        chosen = dev.loc[dev["expectancy_r"].idxmax(), "variant"]
        q = next(q for q in st["keep_quantiles"] if f"modele_top{int(round(100 * (1 - q)))}" == chosen)
        in_val = ((cands["order_time"] >= bounds["val"][0]) & (cands["order_time"] < bounds["val"][1])).to_numpy()
        kept = cands.loc[in_val & masks[q], "r"].to_numpy()
        pool = cands.loc[in_val, "r"].to_numpy()
        rng = np.random.default_rng([cfg["seed"], 77])
        rand = np.array([rng.choice(pool, size=len(kept), replace=False).mean() for _ in range(st["random_subsets"])]) if len(kept) else np.zeros(0)
        ref = float(val.loc["sans_modele_v3", "expectancy_r"])
        adds = bool(len(kept) and val.loc[chosen, "expectancy_r"] > ref and kept.mean() > np.quantile(rand, 0.95))
        result.update(chosen=chosen, keep_quantile=q,
                      validation={"expectancy_r": float(val.loc[chosen, "expectancy_r"]), "reference_unfiltered_r": ref,
                                  "standalone_kept_mean_r": float(kept.mean()) if len(kept) else float("nan"),
                                  "standalone_all_mean_r": float(pool.mean()) if len(pool) else float("nan"),
                                  "random_subsets_p95_r": float(np.quantile(rand, 0.95)) if len(rand) else float("nan"),
                                  "random_subsets_percentile": float(100 * (rand < kept.mean()).mean()) if len(rand) else float("nan"),
                                  "criteria_failed": str(val.loc[chosen, "criteria_failed"]),
                                  "all_criteria": bool(val.loc[chosen, "all_passed"])},
                      model_adds_value=adds, final_test_allowed=bool(adds and val.loc[chosen, "all_passed"]))
    else:
        result.update(chosen=None, model_adds_value=False, final_test_allowed=False)
    (run.RESULTS / "selection.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    run.log(f"study 5 done: chosen={result['chosen']}, model_adds_value={result['model_adds_value']}, "
            f"final_test_allowed={result['final_test_allowed']}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m src.etude5")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    args = parser.parse_args(argv)
    cmd_run(args)


if __name__ == "__main__":
    main(sys.argv[1:])
