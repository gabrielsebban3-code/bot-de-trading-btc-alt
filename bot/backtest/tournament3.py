"""Phase 3 tournament: C1-C5 on the development universe (PROTOCOLE_PHASE3.md)."""
from __future__ import annotations

import itertools
import json
import time
from collections import Counter
from dataclasses import asdict

import numpy as np
import pandas as pd

from ..concepts import c1_trend_breakout as c1
from ..concepts import c2_trend_pullback as c2
from ..concepts import c3_mean_reversion as c3
from ..concepts import c4_funding_oi as c4
from ..concepts import c5_smc_reversal as c5
from ..concepts.base import SymbolData, variant_id
from ..core.logs import get_logger
from ..core.timeutil import DAY_MS, month_of, month_start_ms, to_ms
from ..core.types import Signal
from ..data.storage import MarketStore
from ..data.universe import members
from ..risk.portfolio import CorrelationGroups, Portfolio
from .baseline import random_baseline
from .engine import SymbolMarket, run_backtest
from .metrics import compute_metrics, suspicious
from .stats_tests import deflated_sharpe, spa_test
from .tournament import benchmarks, neighbours as neighbours_c12, trade_regimes, window_daily_returns, year_stability
from .walk_forward import folds, walk_forward

log = get_logger(__name__)
MODULES = {"C1": c1, "C2": c2, "C3": c3, "C4": c4, "C5": c5}


class UniverseLab:
    """Point-in-time universe: data of every member, membership filter, correlation groups."""

    def __init__(self, cfg: dict, store: MarketStore, universe: pd.DataFrame, lookback_days: int = 420):
        self.cfg = cfg
        hist = to_ms(cfg["data"]["history_start"])
        self.membership = set(zip(universe["symbol"], universe["month"]))
        first = universe.groupby("symbol")["month"].min()
        self.data: dict[str, SymbolData] = {}
        self.market: dict[str, SymbolMarket] = {}
        fund_all = []
        for sym, m0 in first.items():
            start = max(hist, month_start_ms(m0) - lookback_days * DAY_MS)
            df15 = store.candles(sym, "15m", start)
            if df15.empty:
                continue
            sd = SymbolData(sym, df15, cfg)
            f = store.funding(sym, start)
            sd.funding = f
            sd.oi = store.open_interest(sym, start)
            m = SymbolMarket(sym, df15, "15m", f, store.candles(sym, "1d", start), cfg)
            for tf in ("1h", "4h", "1d"):
                m.add_tf(tf, sd.bars[tf].df, donchian_ns=(16, 20, 24))
            self.data[sym], self.market[sym] = sd, m
            if len(f):
                fund_all.append(pd.DataFrame({"h": (f["time"].to_numpy() // 3_600_000) * 3_600_000, "rate": f["rate"].to_numpy()}))
        xs = pd.concat(fund_all).groupby("h")["rate"].median().reset_index() if fund_all else pd.DataFrame({"h": [], "rate": []})
        xs = pd.DataFrame({"time": xs["h"].to_numpy(dtype="int64"), "median": xs["rate"].to_numpy()})
        for sd in self.data.values():
            sd.xs_funding = xs
        self.corr = CorrelationGroups({s: sd.bars["1d"].df for s, sd in self.data.items()}, cfg)
        self._signals: dict[str, list[Signal]] = {}
        self.meta: dict[str, Signal] = {}

    def _member(self, s: Signal) -> bool:
        return (s.symbol, month_of(s.generated_at)) in self.membership

    def signals(self, concept: str, params: dict, funding_filter: bool = False) -> list[Signal]:
        vid = variant_id(concept, params) + ("|ff" if funding_filter else "")
        if vid not in self._signals:
            sigs = [s for s in MODULES[concept].generate_signals(self.data, self.cfg, params) if self._member(s)]
            if funding_filter:
                c = self.cfg["concepts"]["c4"]
                sigs = c4.crowded_filter(sigs, self.data, float(c["filter_window_days"]), float(c["filter_z"]))
            self._signals[vid] = sigs
            for s in sigs:
                self.meta[s.id] = s
        return self._signals[vid]

    def forget(self, keep: set[str] | None = None) -> None:
        keep = keep or set()
        self._signals = {k: v for k, v in self._signals.items() if k in keep}

    def run(self, concept: str, params: dict, start: int, end: int, cost_mult: float = 1.0,
            initial_capital: float | None = None, funding_filter: bool = False):
        """Backtest one variant. Runs that do not depend on the walk-forward selection (no chained capital) are
        cached on disk: they are a pure function of the code, the data and the parameters."""
        import hashlib
        import pickle
        from ..core.config import config_hash, resolve_path
        path = None
        if initial_capital is None:
            key = json.dumps([variant_id(concept, params), start, end, cost_mult, funding_filter, config_hash(self.cfg)])
            d = resolve_path(self.cfg, "market_db").parent / "phase3_runs"
            d.mkdir(parents=True, exist_ok=True)
            path = d / (hashlib.sha256(key.encode()).hexdigest()[:24] + ".pkl")
            if path.exists():
                return pickle.loads(path.read_bytes())
        pf = Portfolio(self.cfg, group_fn=self.corr.group)
        out = run_backtest(self.signals(concept, params, funding_filter), self.market, self.cfg, start, end,
                           cost_mult, portfolio=pf, initial_capital=initial_capital)
        if path is not None:
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(pickle.dumps(out))
            tmp.rename(path)
        return out


# ---------------------------------------------------------------- grid, neighbours, ablations

def phase3_variants(cfg: dict) -> list[dict]:
    g2, g3 = cfg["phase2"], cfg["phase3"]
    out = []
    for tf, direction in itertools.product(g2["tfs"], g2["directions"]):
        for n, trail in itertools.product(g2["c1_grid"]["entry_n"], g2["c1_grid"]["trail"]):
            out.append({"concept": "C1", "group": f"C1|{tf}|{direction}",
                        "params": {"tf": tf, "direction": direction, "entry_n": n, "trail": trail}})
        for pb, piv in itertools.product(g2["c2_grid"]["pullback"], g2["c2_grid"]["pivots"]):
            out.append({"concept": "C2", "group": f"C2|{tf}|{direction}",
                        "params": {"tf": tf, "direction": direction, "pullback": pb, "pivots": piv}})
    c3g = g3["c3_grid"]
    for tf, rp, dev in itertools.product(c3g["tf"], c3g["rsi_period"], c3g["deviation"]):
        out.append({"concept": "C3", "group": f"C3|{tf}|both", "params": {"tf": tf, "rsi_period": rp, "deviation": dev}})
    f = g3["c4_grid"]["funding"]
    for sig, w, z in itertools.product(f["signal"], f["window_days"], f["z"]):
        out.append({"concept": "C4", "group": "C4|1h|both", "params": {"signal": sig, "window_days": w, "z": z}})
    for d in g3["c4_grid"]["oi"]["oi_drop"]:
        out.append({"concept": "C4", "group": "C4|1h|both", "params": {"signal": "oi_purge", "oi_drop": d}})
    c5g = g3["c5_grid"]
    for tf, liq, zone, tp, ms in itertools.product(c5g["tf"], c5g["liquidity"], c5g["zone"], c5g["tp_r"], c5g["min_score"]):
        out.append({"concept": "C5", "group": f"C5|{tf}|both",
                    "params": {"tf": tf, "liquidity": liq, "zone": zone, "tp_r": tp, "min_score": ms}})
    for v in out:
        v["id"] = variant_id(v["concept"], v["params"])
    return out


def _shift(params: dict, base: dict, shift: float, ints: set[str], paired: dict | None = None) -> list[dict]:
    out = []
    for k, v in base.items():
        for f in (1 - shift, 1 + shift):
            nv = v * f
            nv = int(round(nv)) if k in ints else round(float(nv), 6)
            if nv == v:
                continue                     # rounding gave the same value: not a perturbation
            q = dict(params)
            q[k] = nv
            if paired and k in paired:
                q[paired[k][0]] = paired[k][1](nv)
            out.append(q)
    return out


def neighbours(concept: str, params: dict, cfg: dict) -> list[dict]:
    if concept in ("C1", "C2"):
        return neighbours_c12(concept, params, cfg)
    shift = float(cfg["robustness"]["param_shift"])
    if concept == "C3":
        c = cfg["concepts"]["c3"]
        base = {"rsi_period": int(params["rsi_period"]), "rsi_low": c["rsi_low"], "stop_atr": c["stop_atr"],
                "max_hold_bars": c["max_hold_bars"], "trend_ema": c["trend_ema"]}
        base["bb_k" if params["deviation"] == "bb" else "vwap_atr"] = c["bb_k"] if params["deviation"] == "bb" else c["vwap_atr"]
        return _shift(params, base, shift, {"rsi_period", "max_hold_bars", "trend_ema"},
                      {"rsi_low": ("rsi_high", lambda x: 100 - x)})
    if concept == "C4":
        c = cfg["concepts"]["c4"]
        base = {"stop_atr": c["stop_atr"], "tp_r": c["tp_r"], "max_hold_bars": c["max_hold_bars"]}
        if params["signal"] == "oi_purge":
            base.update(oi_drop=params["oi_drop"], price_move=c["price_move"])
        else:
            base.update(window_days=params["window_days"], z=params["z"])
        return _shift(params, base, shift, {"max_hold_bars", "window_days"})
    c = cfg["concepts"]["c5"]
    base = {"pivot_n": c["pivot_n"], "choch_window": c["choch_window"], "stop_atr": c["stop_atr"],
            "tp_r": params["tp_r"], "limit_validity_bars": c["limit_validity_bars"]}
    if params["liquidity"] == "equal":
        base["equal_tol"] = c["equal_tol"]
    if params["min_score"]:
        base["min_score"] = params["min_score"]
    return _shift(params, base, shift, {"pivot_n", "choch_window", "limit_validity_bars"})


def ablations(concept: str) -> dict[str, tuple[dict, bool]]:
    """name -> (parameter overrides, funding filter)."""
    if concept == "C1":
        return {"+ filtre volume": ({"volume_filter": True}, False), "− ADX du régime": ({"adx_min": -1}, False),
                "− momentum du régime": ({"use_momentum": False}, False), "+ filtre funding": ({}, True)}
    if concept == "C2":
        return {"− ADX du régime": ({"adx_min": -1}, False), "− momentum du régime": ({"use_momentum": False}, False),
                "+ filtre funding": ({}, True)}
    if concept == "C3":
        return {"+ filtre funding": ({}, True)}
    return {}


# ---------------------------------------------------------------- per-group work (run in worker processes)

_LAB: UniverseLab | None = None
_CFG: dict | None = None


def mfe_mae(lab: UniverseLab, trades: pd.DataFrame) -> dict:
    """Mean favourable / adverse excursion in R during the trades (15m path)."""
    fav, adv = [], []
    for t in trades.itertuples(index=False):
        m = lab.market[t.symbol]
        a = int(np.searchsorted(m.ot, t.entry_time))
        b = int(np.searchsorted(m.ot, t.exit_time))
        r = abs(t.entry_price - t.initial_stop)
        if b <= a or r <= 0:
            continue
        d = 1 if t.direction == "long" else -1
        hi, lo = m.h[a:b + 1].max(), m.l[a:b + 1].min()
        fav.append(((hi - t.entry_price) if d > 0 else (t.entry_price - lo)) / r)
        adv.append(((t.entry_price - lo) if d > 0 else (hi - t.entry_price)) / r)
    return {"mfe_r": float(np.mean(fav)) if fav else np.nan, "mae_r": float(np.mean(adv)) if adv else np.nan}


def run_group(gname: str, vs: list[dict]) -> dict:
    lab, cfg = _LAB, _CFG
    t0 = time.time()
    concept, tf, direction = gname.split("|")
    full_start = to_ms(cfg["data"]["history_start"])
    wf_start, wf_end = to_ms(cfg["walk_forward"]["start"]), to_ms(cfg["walk_forward"]["end"])
    by_id = {v["id"]: v for v in vs}
    full, trials, rets = {}, [], {}
    for v in vs:
        tr, _ = lab.run(v["concept"], v["params"], full_start, wf_end)
        full[v["id"]] = tr
        w = tr[tr["entry_time"] >= wf_start]
        m = compute_metrics(w, cfg["risk"]["initial_capital"], wf_start, wf_end, n_boot=200)
        trials.append({"kind": "grid", "concept": concept, "group": gname, "variant": v["id"],
                       "params": json.dumps(v["params"]), "n_full": len(tr), "n_2022_2026": m["n_trades"],
                       "expectancy_2022_2026": m["expectancy_r"], "pf_2022_2026": m["profit_factor"],
                       "sharpe_2022_2026": m["sharpe"]})
        rets[v["id"]] = window_daily_returns(tr, cfg, wf_start, wf_end)

    def run_fn(vid, a, b, cap, mult=1.0, over=None, ff=False):
        v = by_id[vid]
        p = dict(v["params"], **(over or {}))
        return lab.run(v["concept"], p, a, b, mult, cap, funding_filter=ff)

    oos, sels = walk_forward(run_fn, full, cfg)
    met = compute_metrics(oos, cfg["risk"]["initial_capital"], wf_start, wf_end,
                          rng=np.random.default_rng(int(cfg["seed"])),
                          n_boot=int(cfg["stats"]["bootstrap_resamples"]), level=float(cfg["stats"]["ci_level"]))

    def replay(mult=1.0, over=None, ff=False):
        cap, parts = float(cfg["risk"]["initial_capital"]), []
        for s in sels:
            if s.variant is None:
                continue
            tr, info = run_fn(s.variant, s.test_start, s.test_end, cap, mult, over, ff)
            parts.append(tr.assign(fold=s.fold))
            cap = info["final_capital"]
        return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=oos.columns if len(oos) else [])

    stress = replay(mult=float(cfg["costs"]["stress_multiplier"]))
    e_stress = float(stress["r_multiple"].mean()) if len(stress) else np.nan
    windows = {k: (b, c) for k, (_, b, c) in enumerate(folds(cfg))}
    import zlib
    rng = np.random.default_rng([int(cfg["seed"]), zlib.crc32(gname.encode())])   # reproducible across runs
    base = random_baseline(oos, lab.meta, lab.market, lab.data, cfg, windows, direction, rng) if len(oos) else \
        {"n": 0, "median": np.nan, "p95": np.nan, "percentile": np.nan, "pool": 0}
    chosen = Counter(s.variant for s in sels if s.variant)
    main = chosen.most_common(1)[0][0] if chosen else None
    neigh = []
    if main is not None:
        for q in neighbours(concept, by_id[main]["params"], cfg):
            tr, _ = lab.run(concept, q, wf_start, wf_end)
            neigh.append({"params": q, "n": len(tr), "expectancy": float(tr["r_multiple"].mean()) if len(tr) else np.nan})
    share_neigh = float(np.mean([x["expectancy"] > 0 for x in neigh if np.isfinite(x["expectancy"])])) if neigh else np.nan
    abl = {}
    for name, (over, ff) in ablations(concept).items():
        tr = replay(over=over, ff=ff)
        abl[name] = {"n": len(tr), "expectancy": float(tr["r_multiple"].mean()) if len(tr) else np.nan}
        trials.append({"kind": "ablation", "concept": concept, "group": gname, "variant": name, "params": json.dumps(over)})
    extra = {}
    if concept == "C5" and len(oos):
        extra.update(mfe_mae(lab, oos))
        delays = [dict(lab.meta[i].meta).get("delay_bars", np.nan) for i in oos["signal_id"] if i in lab.meta]
        extra["mean_delay_bars"] = float(np.nanmean(delays)) if delays else np.nan
    elif len(oos):
        extra.update(mfe_mae(lab, oos))
    res = {"group": gname, "concept": concept, "tf": tf, "direction": direction, "metrics": met, "oos": oos,
           "selections": [asdict(s) for s in sels], "e_stress": e_stress, "baseline": base, "main_variant": main,
           "neighbours": neigh, "share_neighbours": share_neigh, "years": year_stability(oos), "ablation": abl,
           "extra": extra, "suspicious": suspicious(met),
           "regimes": trade_regimes(lab, oos, cfg) if len(oos) else oos,
           "oos_returns": window_daily_returns(oos, cfg, wf_start, wf_end) if len(oos) else None,
           "trials": trials, "rets": rets, "seconds": time.time() - t0}
    lab.forget()
    log.info("group done", group=gname, n=met["n_trades"], seconds=round(time.time() - t0))
    return res


def _checkpoint_path(gname: str):
    from ..core.config import resolve_path
    d = resolve_path(_CFG, "market_db").parent / "phase3_groups"
    d.mkdir(parents=True, exist_ok=True)
    return d / (gname.replace("|", "_") + ".pkl")


def _worker(args):
    """Run one group and checkpoint it on disk, so that a restart never recomputes a finished group."""
    import pickle
    gname, vs = args
    path = _checkpoint_path(gname)
    if path.exists():
        return gname
    res = run_group(gname, vs)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(pickle.dumps(res))
    tmp.rename(path)
    return gname


# ---------------------------------------------------------------- phase 3 driver

def run_phase3(cfg: dict, store: MarketStore, workers: int = 3, universe: pd.DataFrame | None = None,
               only_groups: list[str] | None = None) -> dict:
    import multiprocessing as mp
    global _LAB, _CFG
    t0 = time.time()
    _CFG = cfg
    _LAB = UniverseLab(cfg, store, members(store) if universe is None else universe)
    log.info("universe lab ready", symbols=len(_LAB.data), seconds=round(time.time() - t0))
    variants = phase3_variants(cfg)
    groups: dict[str, list[dict]] = {}
    for v in variants:
        if only_groups is None or v["group"] in only_groups:
            groups.setdefault(v["group"], []).append(v)
    variants = [v for v in variants if v["group"] in groups]
    heavy = ["C2|1h", "C5|1h", "C3|1h", "C2|4h", "C5|4h"]
    order = sorted(groups, key=lambda g: (0 if any(g.startswith(h) for h in heavy) else 1, g))
    import pickle
    todo = [g for g in order if not _checkpoint_path(g).exists()]
    log.info("groups to compute", todo=len(todo), done=len(order) - len(todo))
    ctx = mp.get_context("fork")
    # one fresh worker per group: memory grown by the caches of a group is released when it ends
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for g in pool.imap_unordered(_worker, [(g, groups[g]) for g in todo], chunksize=1):
            log.info("checkpoint written", group=g)
    out = [pickle.loads(_checkpoint_path(g).read_bytes()) for g in order]
    wf_start, wf_end = to_ms(cfg["walk_forward"]["start"]), to_ms(cfg["walk_forward"]["end"])
    trials = pd.DataFrame([t for r in out for t in r["trials"]])
    trials.insert(0, "trial", np.arange(1, len(trials) + 1))
    n_total = int(cfg["stats"]["inherited_trials"]) + len(trials)
    ids = [v["id"] for v in variants]
    rets_all = {k: v for r in out for k, v in r["rets"].items()}
    R = np.column_stack([rets_all[i] for i in ids])
    with np.errstate(invalid="ignore", divide="ignore"):
        sr = R.mean(axis=0) / R.std(axis=0, ddof=1)
    sr = sr[np.isfinite(sr)]
    var_sr = float(np.var(sr, ddof=1)) if len(sr) > 1 else 0.0
    spa = spa_test(np.zeros(R.shape[0]), -R, reps=int(cfg["stats"]["spa_reps"]), block=int(cfg["stats"]["spa_block"]),
                   seed=int(cfg["seed"]))
    for r in out:
        met = r["metrics"]
        dsr = deflated_sharpe(r["oos_returns"], n_total, var_sr) if r["oos_returns"] is not None else {"dsr": np.nan}
        r["dsr"] = dsr
        base = r["baseline"]
        crit = {
            "c1_trades": met["n_trades"] >= 100,
            "c2_ci_low": bool(np.isfinite(met.get("ci_low", np.nan)) and met["ci_low"] > 0),
            "c3_spa": spa["p_consistent"] < 0.05,
            "c4_dsr": bool(np.isfinite(dsr["dsr"]) and dsr["dsr"] > 0.95),
            "c5_baseline": bool(np.isfinite(base["p95"]) and met.get("expectancy_r", -1) > base["p95"]),
            "c6_costs": bool(np.isfinite(r["e_stress"]) and r["e_stress"] > 0),
            "c7_neighbours": bool(np.isfinite(r["share_neighbours"]) and r["share_neighbours"] >= float(cfg["robustness"]["min_share_neighbors_positive"])),
            "c8_years": r["years"]["ok"],
        }
        e = met.get("expectancy_r", np.nan)
        if met["n_trades"] == 0 or not np.isfinite(e) or e <= 0:
            status = "pas d'edge"
        elif all(crit.values()):
            status = "candidat : critère 9 à évaluer"
        else:
            status = "non concluant"
        r["criteria"], r["status"] = crit, status
    # criterion 9 (held-out pairs) only for groups passing 1-8
    cand = [r for r in out if r["status"].startswith("candidat")]
    if cand:
        hlab = UniverseLab(cfg, store, members(store, only_holdout=True))
        for r in cand:
            by_id = {v["id"]: v for v in groups[r["group"]]}
            cap, parts = float(cfg["risk"]["initial_capital"]), []
            for s in r["selections"]:
                if not s["variant"]:
                    continue
                v = by_id[s["variant"]]
                tr, info = hlab.run(v["concept"], v["params"], s["test_start"], s["test_end"], 1.0, cap)
                parts.append(tr)
                cap = info["final_capital"]
            ho = pd.concat(parts) if parts else pd.DataFrame()
            e_ho = float(ho["r_multiple"].mean()) if len(ho) else np.nan
            r["holdout"] = {"n": len(ho), "expectancy": e_ho}
            r["criteria"]["c9_holdout"] = bool(np.isfinite(e_ho) and e_ho > 0)
            r["status"] = "candidat en attente du test final" if r["criteria"]["c9_holdout"] else "non concluant (échoue sur les paires mises de côté)"
    return {"results": out, "trials": trials, "n_trials_total": n_total, "spa": spa, "var_sr": var_sr,
            "benchmarks": benchmarks(_LAB, wf_start, wf_end), "wf_start": wf_start, "wf_end": wf_end,
            "seconds": time.time() - t0, "n_symbols": len(_LAB.data)}
