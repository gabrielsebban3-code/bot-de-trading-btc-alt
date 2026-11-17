"""Study 8: the two retail bot families, DCA (safety orders) and long grid, on hourly candles (PROTOCOLE_ETUDE_8.md).

    python -m src.etude8 run

Each pair owns a fixed slot of 1/20 of the initial capital, without leverage. The simulators return the equity of the
slot (in fractions of the slot) at the close of every hourly bar, marked to market.
"""
from __future__ import annotations

import itertools
import json
import multiprocessing as mp
import sys

import numpy as np
import pandas as pd
import yaml

from . import data, etude7, indicators as ind
from .etude7_data import OUT as D7, universe
from .etude8_data import OUT as D8

ROOT = data.ROOT
RESULTS = ROOT / "results_etude8"
H = 3_600_000
_G: dict = {}


def load_cfg() -> dict:
    return yaml.safe_load((ROOT / "config" / "etude8.yaml").read_text())


# ---------------------------------------------------------------- simulators (one pair, one slot = 1.0)

def sim_dca(o, h, l, c, rsi, fpay, valid, p, fx, cs, mult=1.0):
    n = len(c)
    eq, expo = np.zeros(n), np.zeros(n)
    k_max, vs = int(fx["max_safety_orders"]), float(fx["volume_scale"])
    base = 1.0 / sum(vs ** k for k in range(k_max + 1))
    step, tp = float(p["step"]), float(p["take_profit"])
    stop = None if p["stop"] in (None, "none") else float(p["stop"])
    taker, maker, slip = cs["taker_fee"] * mult, cs["maker_fee"] * mult, cs["slippage"] * mult
    realized = units = cost = 0.0
    pending: list[tuple[float, float]] = []
    pos, start, stop_px, exits = False, False, None, 0
    for j in range(n):
        if units > 0.0 and fpay[j] != 0.0:
            realized -= units * o[j] * fpay[j]                       # a long pays a positive funding rate
        if start and not pos:
            px = o[j] * (1.0 + slip)
            units, cost = base / px, base
            realized -= base * taker
            pending = [(o[j] * (1.0 - step * k), base * vs ** k) for k in range(1, k_max + 1)]
            stop_px = o[j] * (1.0 - stop) if stop is not None else None
            pos = True
        start = False
        if pos:
            if stop_px is not None and l[j] <= stop_px:
                for lvl, sz in [x for x in pending if x[0] >= stop_px]:   # orders above the stop fill on the way down
                    units += sz / lvl
                    cost += sz
                    realized -= sz * maker
                px = min(o[j], stop_px) * (1.0 - slip)
                realized += units * px * (1.0 - taker) - cost
                units = cost = 0.0
                pending, pos = [], False
                exits += 1
            else:
                filled = False
                keep = []
                for lvl, sz in pending:
                    if l[j] <= lvl:
                        units += sz / lvl
                        cost += sz
                        realized -= sz * maker
                        filled = True
                    else:
                        keep.append((lvl, sz))
                pending = keep
                if not filled:
                    tp_px = cost / units * (1.0 + tp)
                    if h[j] >= tp_px:
                        realized += units * tp_px * (1.0 - maker) - cost
                        units = cost = 0.0
                        pending, pos = [], False
                        exits += 1
        eq[j] = realized + units * c[j] - cost
        expo[j] = units * c[j]
        if not pos and valid[j] and rsi[j] < fx["rsi_start"]:
            start = True                                               # decided at the close, filled at the next open
    return eq, expo, exits


def sim_grid(o, h, l, c, ot, fpay, valid, p, fx, cs, mult=1.0):
    n = len(c)
    eq, expo = np.zeros(n), np.zeros(n)
    nlev, look = int(p["levels"]), int(p["lookback_days"]) * 24
    per = 1.0 / nlev
    taker, maker, slip = cs["taker_fee"] * mult, cs["maker_fee"] * mult, cs["slippage"] * mult
    realized = 0.0
    inv: dict[int, float] = {}
    buys: set[int] = set()
    lv = None
    active, stop_next, sells = False, False, 0
    monday = ((ot // H) % 24 == 0) & (((ot // (24 * H)) + 3) % 7 == 0)   # 1970-01-01 was a Thursday
    for j in range(n):
        units = sum(inv.values())
        if units > 0.0 and fpay[j] != 0.0:
            realized -= units * o[j] * fpay[j]
        if (monday[j] or stop_next) and inv:
            px = o[j] * (1.0 - slip)
            realized += sum(inv.values()) * px * (1.0 - taker) - per * len(inv)
            inv = {}
        if stop_next:
            active, stop_next, buys = False, False, set()
        if monday[j]:
            active = False
            if j >= look and valid[j]:
                lo, hi = l[j - look:j].min(), h[j - look:j].max()
                step = (hi / lo) ** (1.0 / nlev) - 1.0
                if step >= fx["min_step"]:
                    lv = lo * (1.0 + step) ** np.arange(nlev + 1)
                    buys = {i for i in range(nlev) if lv[i] < o[j]}
                    active = True
        if active:
            bought = []
            for i in sorted(buys, reverse=True):
                if l[j] <= lv[i]:
                    inv[i] = per / lv[i]
                    realized -= per * maker
                    bought.append(i)
            buys.difference_update(bought)
            for i in [i for i in inv if i not in bought]:              # no sale in the bar of its purchase
                if h[j] >= lv[i + 1]:
                    realized += inv.pop(i) * lv[i + 1] * (1.0 - maker) - per
                    buys.add(i)
                    sells += 1
            if c[j] < lv[0] * (1.0 - fx["stop_below_range"]):
                stop_next = True
        held = sum(inv.values())
        eq[j] = realized + held * c[j] - per * len(inv)
        expo[j] = held * c[j]
    return eq, expo, sells


# ---------------------------------------------------------------- portfolio

def pair_arrays(sym: str):
    df = pd.read_parquet(D8 / f"{sym}.parquet")
    ot = df["open_time"].to_numpy(dtype="int64")
    fund = pd.read_parquet(D7 / "funding_daily.parquet")
    f = fund[sym] if sym in fund else pd.Series(dtype=float)
    day = pd.to_datetime(ot, unit="ms", utc=True).floor("D")
    fpay = np.where((ot // H) % 24 == 0, f.reindex(day).fillna(0.0).to_numpy(), 0.0)
    return {"ot": ot, "o": df["open"].to_numpy(), "h": df["high"].to_numpy(), "l": df["low"].to_numpy(),
            "c": df["close"].to_numpy(), "fpay": fpay, "day": day}


def run_pair(task):
    sym, v, mult = task
    cfg, a = _G["cfg"], _G["arrays"][sym]
    fx, cs = cfg["families"][v["family"]]["fixed"], cfg["costs"]
    valid = np.arange(len(a["c"])) >= cfg["warmup_days"] * 24
    if v["family"] == "DCA":
        rsi = ind.rsi(a["c"], fx["rsi_period"])
        eq, expo, n = sim_dca(a["o"], a["h"], a["l"], a["c"], rsi, a["fpay"], valid, v["params"], fx, cs, mult)
    else:
        eq, expo, n = sim_grid(a["o"], a["h"], a["l"], a["c"], a["ot"], a["fpay"], valid, v["params"], fx, cs, mult)
    s = pd.Series(eq, index=a["day"]).groupby(level=0).last()
    e = pd.Series(expo, index=a["day"]).groupby(level=0).mean()
    return sym, v["id"], mult, s, e, n


def variants(cfg):
    out = []
    for fam, f in cfg["families"].items():
        keys = list(f["grid"])
        for combo in itertools.product(*(f["grid"][k] for k in keys)):
            p = dict(zip(keys, combo))
            out.append({"family": fam, "params": p,
                        "id": fam + "_" + "_".join(f"{k}{str(v).replace('.', 'p')}" for k, v in p.items())})
    return out


def shifted(v):
    key = "step" if v["family"] == "DCA" else "levels"
    out = []
    for f in (0.8, 1.2):
        p = dict(v["params"])
        p[key] = round(p[key] * f, 4) if key == "step" else int(round(p[key] * f))
        out.append({"family": v["family"], "params": p, "id": f"{v['id']}__{key}{str(p[key]).replace('.', 'p')}"})
    return out


def portfolio(results, syms, days, n_slots=20):
    eq = pd.DataFrame({s: results[s][0] for s in syms if s in results}).reindex(days).ffill().fillna(0.0)
    expo = pd.DataFrame({s: results[s][1] for s in syms if s in results}).reindex(days).fillna(0.0) / n_slots
    total = 1.0 + eq.sum(axis=1) / n_slots
    ret = total.pct_change().fillna(0.0)
    return ret, expo


def cmd_run(workers: int = 4) -> None:
    cfg = load_cfg()
    RESULTS.mkdir(exist_ok=True)
    u = universe()
    syms = u["in_sample"] + u["new"]
    _G.update(cfg=cfg, arrays={s: pair_arrays(s) for s in syms})
    base = variants(cfg)
    tasks = [(s, v, m) for v in base for s in syms for m in (1.0, cfg["costs"]["sensitivity_multiplier"])]
    tasks += [(s, v, 1.0) for b in base for v in shifted(b) for s in u["in_sample"]]
    with mp.get_context("fork").Pool(workers) as pool:
        out = pool.map(run_pair, tasks, chunksize=4)
    res: dict = {}
    trades: dict = {}
    for sym, vid, mult, s, e, n in out:
        res.setdefault((vid, mult), {})[sym] = (s, e)
        trades[(vid, mult, sym)] = n

    close_all = pd.read_parquet(D7 / "perp_close.parquet")
    regime = etude7.btc_regime(close_all)
    days = close_all.index
    per = cfg["periods"]
    sets = {"in_sample": (u["in_sample"], per["in_sample"]), "oos_time": (u["in_sample"], per["oos_time"]),
            "oos_assets": (u["new"], per["oos_assets"])}
    bh = {}
    rows, curves = [], {}
    for si, (name, (us, pr)) in enumerate(sets.items()):
        avail = etude7.available(close_all[us], 30)
        b = etude7.buy_hold(close_all[us], avail)
        bh[name] = etude7.metrics(b, avail.astype(float), regime, pr["start"], pr["end"], np.random.default_rng([8, si]))
        curves[(name, "buy_hold")] = b.loc[pr["start"]:pr["end"]]
        for vi, v in enumerate(base + ([s for b_ in base for s in shifted(b_)] if name == "in_sample" else [])):
            ret, expo = portfolio(res[(v["id"], 1.0)], us, days)
            m = etude7.metrics(ret, expo, regime, pr["start"], pr["end"], np.random.default_rng([8, si, vi]))
            x2 = res.get((v["id"], cfg["costs"]["sensitivity_multiplier"]))
            r2 = portfolio(x2, us, days)[0] if x2 else None
            tot2 = float(((1 + r2.loc[pr["start"]:pr["end"]]).prod() - 1) * 100) if r2 is not None else np.nan
            rows.append({"set": name, "family": v["family"], "variant": v["id"], "params": json.dumps(v["params"]),
                         "shifted": "__" in v["id"], "trades": int(sum(trades.get((v["id"], 1.0, s), 0) for s in us)),
                         **m, "total_return_x2_pct": tot2})
            curves[(name, v["id"])] = ret.loc[pr["start"]:pr["end"]]
    df = pd.DataFrame(rows)
    df.to_csv(RESULTS / "summary.csv", index=False, float_format="%.6g")
    pd.DataFrame(curves).to_parquet(RESULTS / "daily_returns.parquet")

    sel = {"buy_hold": bh, "families": {}, "n_variants": len(base)}
    ins = df[(df["set"] == "in_sample") & ~df["shifted"]]
    for fam in cfg["families"]:
        f = ins[ins["family"] == fam]
        best = f.loc[f["sharpe"].idxmax()]
        sh = df[(df["set"] == "in_sample") & df["variant"].str.startswith(best["variant"] + "__")]
        e = {"chosen": best["variant"], "in_sample_sharpe": float(best["sharpe"]),
             "stability": {r["variant"]: float(r["sharpe"]) for _, r in sh.iterrows()},
             "stability_ok": bool((sh["sharpe"] > 0).all())}
        for s in ("oos_time", "oos_assets"):
            r = df[(df["set"] == s) & (df["variant"] == best["variant"])].iloc[0].to_dict()
            e[s] = {"metrics": {k: r[k] for k in r if isinstance(r[k], (int, float)) and k != "shifted"},
                    "criteria": etude7.check(r, {"total_return_pct": r["total_return_x2_pct"]}, bh[s], cfg["criteria"])}
        e["retained"] = bool(e["stability_ok"] and e["oos_time"]["criteria"]["all"] and e["oos_assets"]["criteria"]["all"])
        sel["families"][fam] = e
    sel["retained"] = [e["chosen"] for e in sel["families"].values() if e["retained"]]
    (RESULTS / "selection.json").write_text(json.dumps(sel, indent=2, default=float) + "\n")
    print(json.dumps({f: {"chosen": e["chosen"], "IS": round(e["in_sample_sharpe"], 2), "oos_time": e["oos_time"]["criteria"]["failed"],
                          "oos_assets": e["oos_assets"]["criteria"]["failed"], "stable": e["stability_ok"]}
                      for f, e in sel["families"].items()}, indent=1))
    print("retained:", sel["retained"])


if __name__ == "__main__":
    cmd_run()
