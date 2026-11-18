"""Concept tournament (Step 7). Phase 2: C1 and C2 on BTC and ETH, rules of PROTOCOLE_PHASE2.md.

Pipeline: full-period run of every variant -> walk-forward per group (concept x timeframe x direction) ->
controls (random baseline, costs x 1.5, neighbours +-20 %, yearly stability, DSR, SPA) -> verdict per group.
"""
from __future__ import annotations

import copy
import itertools
import json
import time
from collections import Counter
from dataclasses import asdict

import numpy as np
import pandas as pd

from ..concepts import c1_trend_breakout as c1
from ..concepts import c2_trend_pullback as c2
from ..concepts.base import SymbolData, variant_id
from ..core.logs import get_logger
from ..core.timeutil import DAY_MS, to_ms
from ..core.types import Signal
from ..data.storage import MarketStore
from .baseline import random_baseline
from .engine import SymbolMarket, run_backtest
from .metrics import by_period, compute_metrics, daily_returns, suspicious
from .stats_tests import deflated_sharpe, spa_test
from .walk_forward import folds, walk_forward

log = get_logger(__name__)
MODULES = {"C1": c1, "C2": c2}


# ---------------------------------------------------------------- data + cached runs

class Lab:
    """Data of the studied symbols, signal cache and backtest runner (same engine for every concept)."""

    def __init__(self, cfg: dict, store: MarketStore, symbols: list[str]):
        self.cfg = cfg
        start = to_ms(cfg["data"]["history_start"])
        self.data: dict[str, SymbolData] = {}
        self.market: dict[str, SymbolMarket] = {}
        for sym in symbols:
            df15 = store.candles(sym, "15m", start)
            sd = SymbolData(sym, df15, cfg)
            m = SymbolMarket(sym, df15, "15m", store.funding(sym, start), store.candles(sym, "1d", start), cfg)
            for tf in ("1h", "4h", "1d"):
                m.add_tf(tf, sd.bars[tf].df, donchian_ns=(16, 20, 24))
            self.data[sym], self.market[sym] = sd, m
        self._signals: dict[str, list[Signal]] = {}
        self.meta: dict[str, Signal] = {}

    def signals(self, concept: str, params: dict) -> list[Signal]:
        vid = variant_id(concept, params)
        if vid not in self._signals:
            sigs = MODULES[concept].generate_signals(self.data, self.cfg, params)
            self._signals[vid] = sigs
            for s in sigs:
                self.meta[s.id] = s
        return self._signals[vid]

    def run(self, concept: str, params: dict, start: int, end: int, cost_mult: float = 1.0,
            initial_capital: float | None = None) -> tuple[pd.DataFrame, dict]:
        return run_backtest(self.signals(concept, params), self.market, self.cfg, start, end, cost_mult,
                            initial_capital=initial_capital)


# ---------------------------------------------------------------- grid

def phase2_variants(cfg: dict) -> list[dict]:
    g = cfg["phase2"]
    out = []
    for tf, direction in itertools.product(g["tfs"], g["directions"]):
        for n, trail in itertools.product(g["c1_grid"]["entry_n"], g["c1_grid"]["trail"]):
            out.append({"concept": "C1", "group": f"C1|{tf}|{direction}",
                        "params": {"tf": tf, "direction": direction, "entry_n": n, "trail": trail}})
        for pb, piv in itertools.product(g["c2_grid"]["pullback"], g["c2_grid"]["pivots"]):
            out.append({"concept": "C2", "group": f"C2|{tf}|{direction}",
                        "params": {"tf": tf, "direction": direction, "pullback": pb, "pivots": piv}})
    for v in out:
        v["id"] = variant_id(v["concept"], v["params"])
    return out


def neighbours(concept: str, params: dict, cfg: dict) -> list[dict]:
    """Each numeric parameter of the variant (and of its config defaults) shifted by -20 % and +20 %."""
    shift = float(cfg["robustness"]["param_shift"])
    reg = cfg["concepts"]["regime"]
    base: dict = {"ema_fast": reg["ema_fast"], "ema_slow": reg["ema_slow"], "adx_min": reg["adx_min"],
                  "momentum_days": reg["momentum_days"]}
    ints = {"ema_fast", "ema_slow", "momentum_days", "entry_n", "trail_donchian_n", "pullback_window",
            "ema_period", "fractal_n"}
    if concept == "C1":
        cc = cfg["concepts"]["c1"]
        base["stop_atr"] = cc["stop_atr"]
        if params["entry_n"] != "ensemble":
            base["entry_n"] = int(params["entry_n"])
        if params["trail"] == "chandelier":
            base["trail_chandelier_atr"] = cc["trail_chandelier_atr"]
        else:
            base["trail_donchian_n"] = cc["trail_donchian_n"]
    else:
        cc = cfg["concepts"]["c2"]
        base.update(pullback_window=cc["pullback_window"], stop_buffer_atr=cc["stop_buffer_atr"],
                    trail_chandelier_atr=cc["trail_chandelier_atr"])
        if params["pullback"].startswith("ema"):
            base["ema_period"] = int(params["pullback"][3:])
        else:
            base["zone_atr"] = cc["zone_atr"]
        if params["pivots"] == "fractal":
            base["fractal_n"] = cfg["structure"]["fractal_n"]
        elif params["pivots"] == "zigzag":
            base["zigzag_atr_mult"] = cfg["structure"]["zigzag_atr_mult"]
    out = []
    for k, v in base.items():
        for f in (1 - shift, 1 + shift):
            nv = v * f
            nv = int(round(nv)) if k in ints else round(float(nv), 6)
            if k == "trail_donchian_n" and nv not in (16, 24):
                continue
            q = dict(params)
            q[k] = str(nv) if k == "entry_n" else nv
            out.append(q)
    return out


# ---------------------------------------------------------------- helpers

def window_daily_returns(trades: pd.DataFrame, cfg: dict, start: int, end: int) -> np.ndarray:
    init = float(cfg["risk"]["initial_capital"])
    if trades.empty:
        return np.zeros(int(np.ceil((end - start) / DAY_MS)))
    before = trades[trades["exit_time"] < start]["pnl"].sum()
    w = trades[(trades["exit_time"] >= start) & (trades["exit_time"] < end)]
    return daily_returns(w, init + before, start, end)


def year_stability(trades: pd.DataFrame) -> dict:
    y = by_period(trades, "Y")
    if y.empty:
        return {"years": 0, "share_positive": np.nan, "max_share": np.nan, "ok": False, "table": y}
    total = y["sum_r"].sum()
    share_pos = float((y["sum_r"] > 0).mean())
    max_share = float(y["sum_r"].max() / total) if total > 0 else np.nan
    ok = bool(total > 0 and share_pos >= 0.6 and max_share <= 0.5)
    return {"years": int(len(y)), "share_positive": share_pos, "max_share": max_share, "ok": ok, "table": y}


def benchmarks(lab: Lab, start: int, end: int) -> dict:
    rets = {}
    # benchmarks are BTC and the BTC+ETH basket only: with the phase-3 universe (delisted pairs included), dropna()
    # over every symbol would leave no common day at all
    for sym, sd in lab.data.items():
        if sym not in ("BTCUSDT", "ETHUSDT"):
            continue
        d = sd.bars["1d"]
        sel = (d.ot >= start - DAY_MS) & (d.ot < end)
        c = d.c[sel]
        rets[sym] = pd.Series(np.diff(c) / c[:-1], index=d.ot[sel][1:])
    df = pd.DataFrame(rets).dropna()
    out = {}
    for name, r in [("BTC buy & hold", df.get("BTCUSDT")), ("Panier BTC+ETH", df.mean(axis=1))]:
        if r is None:
            continue
        eq = np.cumprod(1 + r.to_numpy())
        peak = np.maximum.accumulate(eq)
        out[name] = {"total_return_pct": 100 * (eq[-1] - 1), "sharpe": float(r.mean() / r.std(ddof=1) * np.sqrt(365)),
                     "max_dd_pct": 100 * float(((peak - eq) / peak).max()), "curve": (r.index.to_numpy(), eq)}
    return out


def trade_regimes(lab: Lab, trades: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Regime of each trade at entry: range / trend (daily compression) and high volatility (top 20 % ATR)."""
    from ..data.resampler import align_closed
    from ..indicators._core import rolling_rank_pct
    from ..structure.market_structure import range_state
    if trades.empty:
        return trades.assign(regime=[], high_vol=[])
    reg, hv = np.empty(len(trades), dtype=object), np.zeros(len(trades), dtype=bool)
    for sym, idx in trades.groupby("symbol").groups.items():
        d = lab.data[sym].bars["1d"]
        rng = range_state(d.h, d.l, d.c, cfg["structure"]["range"]).astype(float)
        vr = rolling_rank_pct(d.atr(14) / d.c, 365)
        t = trades.loc[idx, "entry_time"].to_numpy(dtype="int64")
        r_at = align_closed(t, d.ct, rng)
        v_at = align_closed(t, d.ct, vr)
        pos = trades.index.get_indexer(idx)
        reg[pos] = np.where(r_at == 1.0, "range", "tendance")
        hv[pos] = v_at >= 0.8
    return trades.assign(regime=reg, high_vol=hv)


# ---------------------------------------------------------------- phase 2

def run_phase2(cfg: dict, store: MarketStore, out_dir, quick: bool = False) -> dict:
    t0 = time.time()
    lab = Lab(cfg, store, cfg["phase2"]["symbols"])
    full_start = to_ms(cfg["data"]["history_start"])
    wf_start, wf_end = to_ms(cfg["walk_forward"]["start"]), to_ms(cfg["walk_forward"]["end"])
    variants = phase2_variants(cfg)
    if quick:
        variants = [v for v in variants if v["params"]["tf"] == "4h"]
    # 1. full-period run of every variant (selection data + SPA/DSR inputs)
    full: dict[str, pd.DataFrame] = {}
    trials = []
    for v in variants:
        tr, info = lab.run(v["concept"], v["params"], full_start, wf_end)
        full[v["id"]] = tr
        w = tr[tr["entry_time"] >= wf_start]
        m = compute_metrics(w, cfg["risk"]["initial_capital"], wf_start, wf_end, n_boot=200)
        trials.append({"trial": len(trials) + 1, "kind": "grid", "concept": v["concept"], "group": v["group"],
                       "variant": v["id"], "params": json.dumps(v["params"]), "n_full": len(tr),
                       "n_2022_2026": m["n_trades"], "expectancy_2022_2026": m["expectancy_r"],
                       "pf_2022_2026": m["profit_factor"], "sharpe_2022_2026": m["sharpe"]})
    log.info("full-period runs done", variants=len(variants), seconds=round(time.time() - t0))
    # SPA and DSR inputs: daily returns of every grid variant over the validation window
    rets = np.column_stack([window_daily_returns(full[v["id"]], cfg, wf_start, wf_end) for v in variants])
    with np.errstate(invalid="ignore", divide="ignore"):
        sr = rets.mean(axis=0) / rets.std(axis=0, ddof=1)
    sr = sr[np.isfinite(sr)]
    var_sr = float(np.var(sr, ddof=1)) if len(sr) > 1 else 0.0
    spa = spa_test(np.zeros(rets.shape[0]), -rets, reps=int(cfg["stats"]["spa_reps"]),
                   block=int(cfg["stats"]["spa_block"]), seed=int(cfg["seed"]))
    # 2. walk-forward per group (+ volume ablation for C1)
    groups: dict[str, list[dict]] = {}
    for v in variants:
        groups.setdefault(v["group"], []).append(v)
    ablation_full: dict[str, dict[str, pd.DataFrame]] = {}
    for gname, vs in groups.items():
        if vs[0]["concept"] != "C1":
            continue
        ablation_full[gname] = {}
        for v in vs:
            p = dict(v["params"], volume_filter=True)
            vid = variant_id("C1", p)
            tr, _ = lab.run("C1", p, full_start, wf_end)
            ablation_full[gname][vid] = tr
            trials.append({"trial": len(trials) + 1, "kind": "ablation_volume", "concept": "C1", "group": gname,
                           "variant": vid, "params": json.dumps(p), "n_full": len(tr)})
    n_trials_total = int(cfg["stats"]["inherited_trials"]) + len(trials)
    windows = {k: (b, c) for k, (_, b, c) in enumerate(folds(cfg))}
    rng = np.random.default_rng(int(cfg["seed"]))
    results = []
    for gname, vs in groups.items():
        concept, tf, direction = gname.split("|")
        by_id = {v["id"]: v for v in vs}

        def run_fn(vid, a, b, cap, _by=by_id, mult=1.0):
            v = _by[vid]
            return lab.run(v["concept"], v["params"], a, b, mult, cap)

        oos, sels = walk_forward(run_fn, {v["id"]: full[v["id"]] for v in vs}, cfg)
        met = compute_metrics(oos, cfg["risk"]["initial_capital"], wf_start, wf_end,
                              rng=np.random.default_rng(int(cfg["seed"])),
                              n_boot=int(cfg["stats"]["bootstrap_resamples"]), level=float(cfg["stats"]["ci_level"]))
        # costs x 1.5 with the same selections
        capital, parts = float(cfg["risk"]["initial_capital"]), []
        for s in sels:
            if s.variant is None:
                continue
            tr, info = run_fn(s.variant, s.test_start, s.test_end, capital, mult=float(cfg["costs"]["stress_multiplier"]))
            parts.append(tr)
            capital = info["final_capital"]
        stress = pd.concat(parts) if parts else pd.DataFrame(columns=oos.columns)
        e_stress = float(stress["r_multiple"].mean()) if len(stress) else np.nan
        # random baseline
        base = random_baseline(oos, lab.meta, lab.market, lab.data, cfg, windows, direction, rng) if len(oos) else \
            {"n": 0, "median": np.nan, "p95": np.nan, "percentile": np.nan, "pool": 0}
        # neighbours of the most often selected variant
        chosen = Counter(s.variant for s in sels if s.variant)
        main = chosen.most_common(1)[0][0] if chosen else None
        neigh = []
        if main is not None:
            for q in neighbours(concept, by_id[main]["params"], cfg):
                tr, _ = lab.run(concept, q, wf_start, wf_end)
                neigh.append({"params": q, "n": len(tr), "expectancy": float(tr["r_multiple"].mean()) if len(tr) else np.nan})
        share_neigh = float(np.mean([x["expectancy"] > 0 for x in neigh if np.isfinite(x["expectancy"])])) if neigh else np.nan
        years = year_stability(oos)
        dr = window_daily_returns(oos.assign(), cfg, wf_start, wf_end) if len(oos) else np.zeros(1)
        dsr = deflated_sharpe(dr, n_trials_total, var_sr)
        # ablation
        abl = None
        if concept == "C1":
            ab_by = {variant_id("C1", dict(v["params"], volume_filter=True)): dict(v, params=dict(v["params"], volume_filter=True))
                     for v in vs}

            def run_ab(vid, a, b, cap, _by=ab_by):
                v = _by[vid]
                return lab.run("C1", v["params"], a, b, 1.0, cap)

            oos_ab, _ = walk_forward(run_ab, ablation_full[gname], cfg)
            abl = {"n": len(oos_ab), "expectancy": float(oos_ab["r_multiple"].mean()) if len(oos_ab) else np.nan}
        crit = {
            "c1_trades": met["n_trades"] >= 100,
            "c2_ci_low": bool(np.isfinite(met.get("ci_low", np.nan)) and met["ci_low"] > 0),
            "c3_spa": spa["p_consistent"] < 0.05,
            "c4_dsr": bool(np.isfinite(dsr["dsr"]) and dsr["dsr"] > 0.95),
            "c5_baseline": bool(np.isfinite(base["p95"]) and met.get("expectancy_r", -1) > base["p95"]),
            "c6_costs": bool(np.isfinite(e_stress) and e_stress > 0),
            "c7_neighbours": bool(np.isfinite(share_neigh) and share_neigh >= float(cfg["robustness"]["min_share_neighbors_positive"])),
            "c8_years": years["ok"],
        }
        e = met.get("expectancy_r", np.nan)
        if met["n_trades"] == 0 or not np.isfinite(e) or e <= 0:
            status = "pas d'edge"
        elif all(crit.values()):
            status = "candidat (Phase 3)"
        else:
            status = "non concluant"
        results.append({"group": gname, "concept": concept, "tf": tf, "direction": direction, "metrics": met,
                        "oos": oos, "selections": [asdict(s) for s in sels], "e_stress": e_stress, "baseline": base,
                        "main_variant": main, "neighbours": neigh, "share_neighbours": share_neigh, "years": years,
                        "dsr": dsr, "ablation": abl, "criteria": crit, "status": status,
                        "suspicious": suspicious(met), "regimes": trade_regimes(lab, oos, cfg) if len(oos) else oos})
        log.info("group done", group=gname, n=met["n_trades"], expectancy=round(e, 4) if np.isfinite(e) else None,
                 status=status)
    return {"results": results, "trials": pd.DataFrame(trials), "n_trials_total": n_trials_total, "spa": spa,
            "var_sr": var_sr, "benchmarks": benchmarks(lab, wf_start, wf_end), "full": full, "variants": variants,
            "wf_start": wf_start, "wf_end": wf_end, "seconds": time.time() - t0}
