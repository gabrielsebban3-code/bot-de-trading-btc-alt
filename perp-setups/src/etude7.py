"""Study 7: daily portfolio strategies (TSMOM, XSMOM, CARRY), see PROTOCOLE_ETUDE_7.md.

    python -m src.etude7 run       all variants, selection on the in-sample set, two out-of-sample sets, verdict

Timing: row d holds the daily candle that opens at d 00:00 UTC. A decision uses rows <= d (known at the close of
day d) and earns the returns of row d + 1. Weights are fractions of capital.
"""
from __future__ import annotations

import itertools
import json
import sys

import numpy as np
import pandas as pd
import yaml

from . import data
from .etude7_data import OUT as DATA, universe

ROOT = data.ROOT
RESULTS = ROOT / "results_etude7"
DAYS = 365.0


def load_cfg() -> dict:
    return yaml.safe_load((ROOT / "config" / "etude7.yaml").read_text())


def load_market():
    close = pd.read_parquet(DATA / "perp_close.parquet")
    spot = pd.read_parquet(DATA / "spot_close.parquet").reindex(close.index)
    fund = pd.read_parquet(DATA / "funding_daily.parquet").reindex(close.index).fillna(0.0)
    return close, spot, fund


# ---------------------------------------------------------------- weights (decided on row d, held on row d + 1)

def available(close: pd.DataFrame, warmup: int) -> pd.DataFrame:
    return close.notna() & (close.notna().cumsum() >= warmup)


def weekly(frame: pd.DataFrame) -> pd.DataFrame:
    """Keep the decisions taken at the close of Sundays, hold them for the week."""
    sunday = frame.index.day_of_week == 6
    out = frame.where(pd.Series(sunday, index=frame.index), np.nan).ffill()
    return out.fillna(0.0)


def w_tsmom(close, avail, p, fx):
    ret_l = close / close.shift(p["lookback"]) - 1.0
    vol = close.pct_change(fill_method=None).rolling(fx["vol_window"]).std() * np.sqrt(DAYS)
    sign = np.sign(ret_l)
    if p["side"] == "long_only":
        sign = sign.clip(lower=0.0)
    ok = avail & ret_l.notna() & vol.notna() & (vol > 0)
    n = ok.sum(axis=1).replace(0, np.nan)
    w = (sign * fx["target_vol_per_asset"] / vol).where(ok, 0.0).div(n, axis=0).fillna(0.0)
    gross = w.abs().sum(axis=1)
    scale = (fx["max_gross_leverage"] / gross).clip(upper=1.0).fillna(1.0)
    return weekly(w.mul(scale, axis=0))


def w_xsmom(close, avail, p, fx):
    ret_l = close / close.shift(p["lookback"]) - 1.0
    ok = avail & ret_l.notna()
    k = int(p["n_each_side"])
    rank = ret_l.where(ok).rank(axis=1, method="first", ascending=False)
    n = ok.sum(axis=1)
    top = rank <= k
    bottom = rank.gt(n - k, axis=0) & ok
    enough = n >= 2 * k
    w = (top.astype(float) - bottom.astype(float)) * fx["gross_leverage"] / (2 * k)
    return weekly(w.mul(enough.astype(float), axis=0))


def carry_active(spot, fund, avail, p):
    ann = fund.rolling(int(p["window_days"])).mean() * DAYS
    ok = avail & spot.notna() & spot.shift(1).notna()
    return (ann > p["min_annual_funding"]) & ok


# ---------------------------------------------------------------- daily returns of a strategy

def run_directional(w: pd.DataFrame, close: pd.DataFrame, fund: pd.DataFrame, costs: dict, mult: float = 1.0):
    r = close.pct_change(fill_method=None).fillna(0.0)
    held = w.shift(1).fillna(0.0)                          # decided on d, held on d + 1
    gross = (held * r).sum(axis=1)
    funding = -(held * fund).sum(axis=1)                  # a long pays a positive funding rate
    turnover = (w - w.shift(1).fillna(0.0)).abs().sum(axis=1).shift(1).fillna(0.0)
    cost = turnover * (costs["perp_fee"] + costs["slippage"]) * mult
    trades = int(((w != 0) & (w.shift(1).fillna(0.0) != w)).sum().sum())
    return gross + funding - cost, held, trades


def run_carry(active: pd.DataFrame, close, spot, fund, eligible: pd.DataFrame, fx, costs, mult: float = 1.0):
    n = eligible.sum(axis=1).replace(0, np.nan)
    notional = active.astype(float).div(n, axis=0).fillna(0.0) / (1.0 + fx["perp_margin_share"])
    held = notional.shift(1).fillna(0.0)
    r_perp = close.pct_change(fill_method=None).fillna(0.0)
    r_spot = spot.pct_change(fill_method=None).fillna(0.0)
    pnl = (held * (r_spot - r_perp + fund)).sum(axis=1)
    leg_cost = costs["perp_fee"] + costs["spot_fee"] + 2 * costs["slippage"]
    turnover = (notional - notional.shift(1).fillna(0.0)).abs().sum(axis=1).shift(1).fillna(0.0)
    trades = int((active & ~active.shift(1, fill_value=False)).sum().sum())
    return pnl - turnover * leg_cost * mult, held, trades


# ---------------------------------------------------------------- metrics

def btc_regime(close: pd.DataFrame) -> pd.Series:
    r90 = close["BTCUSDT"] / close["BTCUSDT"].shift(90) - 1.0
    reg = pd.Series(np.where(r90 > 0.2, "hausse", np.where(r90 < -0.2, "baisse", "range")), index=close.index)
    return reg.where(r90.notna()).shift(1)                 # regime known at the decision, applied to the next day


def block_bootstrap_sharpe(x: np.ndarray, rng, n=5000, block=20) -> tuple[float, float]:
    if len(x) < 2 * block:
        return float("nan"), float("nan")
    starts = np.arange(len(x) - block + 1)
    k = int(np.ceil(len(x) / block))
    out = np.empty(n)
    for i in range(n):
        idx = (rng.choice(starts, k)[:, None] + np.arange(block)).ravel()[: len(x)]
        s = x[idx]
        out[i] = s.mean() / s.std() * np.sqrt(DAYS) if s.std() > 0 else 0.0
    return float(np.quantile(out, 0.025)), float(np.quantile(out, 0.975))


def metrics(ret: pd.Series, held: pd.DataFrame, regime: pd.Series, a: str, b: str, rng) -> dict:
    s = ret.loc[a:b]
    if len(s) < 30 or s.abs().sum() == 0:
        return {"days": len(s), "sharpe": float("nan")}
    eq = (1.0 + s).cumprod()
    dd = float((1.0 - eq / eq.cummax()).max())
    years = len(s) / DAYS
    q = (1.0 + s).groupby(s.index.to_period("Q")).prod() - 1.0
    reg = s.groupby(regime.loc[a:b]).sum()
    lo, hi = block_bootstrap_sharpe(s.to_numpy(), rng)
    h = held.loc[a:b]
    return {"days": len(s), "total_return_pct": 100 * (eq.iloc[-1] - 1.0),
            "cagr_pct": 100 * (eq.iloc[-1] ** (1 / years) - 1.0), "vol_pct": 100 * s.std() * np.sqrt(DAYS),
            "sharpe": float(s.mean() / s.std() * np.sqrt(DAYS)) if s.std() > 0 else float("nan"),
            "sharpe_ci_low": lo, "sharpe_ci_high": hi, "max_dd_pct": 100 * dd,
            "share_quarters_positive": float((q > 0).mean()), "n_quarters": int(len(q)),
            "share_days_invested": float((h.abs().sum(axis=1) > 0).mean()),
            "avg_gross_exposure": float(h.abs().sum(axis=1).mean()),
            **{f"regime_{k}_sum_pct": 100 * float(v) for k, v in reg.items()},
            "regimes_positive": int((reg > 0).sum())}


def buy_hold(close: pd.DataFrame, avail: pd.DataFrame) -> pd.Series:
    r = close.pct_change(fill_method=None)
    w = avail.astype(float).div(avail.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0)
    return (w.shift(1).fillna(0.0) * r.fillna(0.0)).sum(axis=1)


# ---------------------------------------------------------------- study

def variants(cfg) -> list[dict]:
    out = []
    for fam, f in cfg["families"].items():
        keys = list(f["grid"])
        for combo in itertools.product(*(f["grid"][k] for k in keys)):
            p = dict(zip(keys, combo))
            out.append({"family": fam, "params": p,
                        "id": fam + "_" + "_".join(f"{k}{str(v).replace('.', 'p')}" for k, v in p.items())})
    return out


def simulate(v, close, spot, fund, avail, cfg, mult=1.0):
    fx, costs = cfg["families"][v["family"]]["fixed"], cfg["costs"]
    if v["family"] == "TSMOM":
        return run_directional(w_tsmom(close, avail, v["params"], fx), close, fund, costs, mult)
    if v["family"] == "XSMOM":
        return run_directional(w_xsmom(close, avail, v["params"], fx), close, fund, costs, mult)
    act = carry_active(spot, fund, avail, v["params"])
    elig = avail & spot.notna()
    return run_carry(act, close, spot, fund, elig, fx, costs, mult)


def shifted(v) -> list[dict]:
    key = {"TSMOM": "lookback", "XSMOM": "lookback", "CARRY": "window_days"}[v["family"]]
    out = []
    for f in (0.8, 1.2):
        p = dict(v["params"])
        p[key] = max(1, int(round(p[key] * f)))
        out.append({"family": v["family"], "params": p, "id": f"{v['id']}__{key}{p[key]}"})
    return out


def check(m: dict, m2: dict, bh: dict, cr: dict) -> dict:
    c = {"c1_sharpe": m.get("sharpe", np.nan) >= cr["min_sharpe"],
         "c2_ci": m.get("sharpe_ci_low", np.nan) > 0,
         "c3_drawdown": m.get("max_dd_pct", np.inf) < cr["max_drawdown_pct"],
         "c4_costs_x2": m2.get("total_return_pct", -1) > 0,
         "c5_quarters": m.get("share_quarters_positive", 0) >= cr["min_share_quarters_positive"],
         "c6_regimes": m.get("regimes_positive", 0) >= cr["min_regimes_positive"],
         "c7_buy_hold": m.get("sharpe", np.nan) > bh.get("sharpe", np.nan)}
    c = {k: bool(v) for k, v in c.items()}
    c["failed"] = ",".join(k.split("_")[0] for k, v in c.items() if not v)
    c["all"] = not c["failed"]
    return c


def cmd_run() -> None:
    cfg = load_cfg()
    RESULTS.mkdir(exist_ok=True)
    close_all, spot_all, fund_all = load_market()
    u = universe()
    per = cfg["periods"]
    regime = btc_regime(close_all)
    sets = {"in_sample": (u["in_sample"], per["in_sample"]), "oos_time": (u["in_sample"], per["oos_time"]),
            "oos_assets": (u["new"], per["oos_assets"])}
    rng = lambda tag: np.random.default_rng([42, tag])
    rows, curves = [], {}
    bh = {}
    for si, (name, (syms, pr)) in enumerate(sets.items()):
        close, spot, fund = close_all[syms], spot_all.reindex(columns=syms), fund_all.reindex(columns=syms).fillna(0.0)
        avail = available(close, cfg["warmup_days"])
        b = buy_hold(close, avail)
        bh[name] = metrics(b, avail.astype(float), regime, pr["start"], pr["end"], rng(900 + si))
        curves[(name, "buy_hold")] = b.loc[pr["start"]:pr["end"]]
        for vi, v in enumerate(variants(cfg) + [s for v in variants(cfg) for s in shifted(v)] if name == "in_sample" else variants(cfg)):
            ret, held, trades = simulate(v, close, spot, fund, avail, cfg)
            ret2, _, _ = simulate(v, close, spot, fund, avail, cfg, cfg["costs"]["sensitivity_multiplier"])
            m = metrics(ret, held, regime, pr["start"], pr["end"], rng(si * 1000 + vi))
            m2 = metrics(ret2, held, regime, pr["start"], pr["end"], rng(si * 1000 + vi + 500))
            a, z = pd.Timestamp(pr["start"], tz="UTC"), pd.Timestamp(pr["end"], tz="UTC")
            n_tr = int(((held.loc[a:z] != 0) & (held.loc[a:z].shift(1).fillna(0.0) == 0)).sum().sum())
            rows.append({"set": name, "family": v["family"], "variant": v["id"], "params": json.dumps(v["params"]),
                         "shifted": "__" in v["id"], "entries": n_tr, **m,
                         "total_return_x2_pct": m2.get("total_return_pct", np.nan)})
            curves[(name, v["id"])] = ret.loc[pr["start"]:pr["end"]]
    df = pd.DataFrame(rows)
    df.to_csv(RESULTS / "summary.csv", index=False, float_format="%.6g")
    pd.DataFrame(curves).to_parquet(RESULTS / "daily_returns.parquet")

    ins = df[(df["set"] == "in_sample") & ~df["shifted"]]
    out = {"buy_hold": bh, "families": {}, "n_variants": int(len(ins)), "n_shifted": int(df["shifted"].sum())}
    for fam in cfg["families"]:
        f = ins[ins["family"] == fam]
        best = f.loc[f["sharpe"].idxmax()]
        sh = df[(df["set"] == "in_sample") & df["variant"].str.startswith(best["variant"] + "__")]
        entry = {"chosen": best["variant"], "in_sample_sharpe": float(best["sharpe"]),
                 "stability": {r["variant"]: float(r["sharpe"]) for _, r in sh.iterrows()},
                 "stability_ok": bool((sh["sharpe"] > 0).all())}
        for s in ("oos_time", "oos_assets"):
            r = df[(df["set"] == s) & (df["variant"] == best["variant"])].iloc[0].to_dict()
            m2 = {"total_return_pct": r["total_return_x2_pct"]}
            entry[s] = {"metrics": {k: r[k] for k in r if isinstance(r[k], (int, float)) and k != "shifted"},
                        "criteria": check(r, m2, bh[s], cfg["criteria"])}
        entry["retained"] = bool(entry["stability_ok"] and entry["oos_time"]["criteria"]["all"] and entry["oos_assets"]["criteria"]["all"])
        out["families"][fam] = entry
    out["retained"] = [e["chosen"] for e in out["families"].values() if e["retained"]]
    (RESULTS / "selection.json").write_text(json.dumps(out, indent=2, default=float) + "\n")
    print(json.dumps({f: {"chosen": e["chosen"], "IS": round(e["in_sample_sharpe"], 2),
                          "oos_time": e["oos_time"]["criteria"]["failed"], "oos_assets": e["oos_assets"]["criteria"]["failed"],
                          "stable": e["stability_ok"]} for f, e in out["families"].items()}, indent=1))
    print("retained:", out["retained"])


if __name__ == "__main__":
    {"run": cmd_run}[sys.argv[1] if len(sys.argv) > 1 else "run"]()
