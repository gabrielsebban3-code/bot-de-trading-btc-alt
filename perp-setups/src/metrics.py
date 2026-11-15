"""Statistics on trade lists: performance metrics, bootstrap, breakdowns, selection and verdict rules."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data import BAR_MS

DAY_MS = 86_400_000


def _ms(series: pd.Series) -> np.ndarray:
    return series.dt.as_unit("ms").astype("int64").to_numpy()


def profit_factor(r: np.ndarray) -> float:
    gains = r[r > 0].sum()
    losses = -r[r < 0].sum()
    if losses == 0:
        return float("inf") if gains > 0 else float("nan")
    return float(gains / losses)


def bootstrap_ci(r: np.ndarray, n_resamples: int, level: float, rng: np.random.Generator) -> tuple[float, float]:
    """Percentile bootstrap confidence interval of the mean (trades resampled with replacement)."""
    n = len(r)
    if n == 0:
        return float("nan"), float("nan")
    means = np.empty(n_resamples)
    chunk = max(1, min(n_resamples, 4_000_000 // n))
    done = 0
    while done < n_resamples:
        m = min(chunk, n_resamples - done)
        idx = rng.integers(0, n, size=(m, n))
        means[done: done + m] = r[idx].mean(axis=1)
        done += m
    alpha = (1.0 - level) / 2.0
    lo, hi = np.quantile(means, [alpha, 1.0 - alpha])
    return float(lo), float(hi)


def max_drawdown(curve: np.ndarray, start_value: float, relative: bool) -> float:
    """Largest peak-to-trough decline of ``start_value + cumulative curve``."""
    if len(curve) == 0:
        return 0.0
    eq = np.concatenate(([start_value], start_value + curve))
    peak = np.maximum.accumulate(eq)
    dd = (peak - eq) / peak if relative else peak - eq
    return float(dd.max())


def longest_losing_streak(r: np.ndarray) -> int:
    best = cur = 0
    for x in r:
        if x < 0:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def time_in_position_pct(entry_ms: np.ndarray, exit_ms: np.ndarray, start_ms: int, end_ms: int) -> float:
    """Share of the period during which at least one position is open (15m resolution)."""
    if len(entry_ms) == 0:
        return 0.0
    order = np.argsort(entry_ms, kind="stable")
    a, b = entry_ms[order], exit_ms[order] + BAR_MS
    total, cur_a, cur_b = 0, a[0], b[0]
    for x, y in zip(a[1:], b[1:]):
        if x <= cur_b:
            cur_b = max(cur_b, y)
        else:
            total += cur_b - cur_a
            cur_a, cur_b = x, y
    total += cur_b - cur_a
    return float(100.0 * total / (end_ms - start_ms))


def compute_metrics(trades: pd.DataFrame, cfg: dict, start_ms: int, end_ms: int,
                    rng: np.random.Generator | None = None) -> dict:
    """All metrics of section 8 for one trade list (one configuration, one set)."""
    initial = float(cfg["engine"]["initial_capital"])
    n = len(trades)
    months = (end_ms - start_ms) / (30.4375 * DAY_MS)
    out = {"n_trades": n, "trades_per_month": n / months if months > 0 else float("nan")}
    keys = ["win_rate", "expectancy_r", "median_r", "profit_factor", "ci_low", "ci_high", "max_dd_pct",
            "max_dd_r", "sharpe", "calmar", "longest_losing_streak", "avg_hold_hours", "time_in_position_pct",
            "total_return_pct", "sum_r", "gross_pnl", "costs_total", "cost_share_of_gross", "final_capital"]
    if n == 0:
        out.update({k: float("nan") for k in keys})
        out.update(longest_losing_streak=0, time_in_position_pct=0.0, total_return_pct=0.0, sum_r=0.0,
                   final_capital=initial, max_dd_pct=0.0, max_dd_r=0.0)
        return out
    t = trades.sort_values(["exit_time", "trade_id"], kind="stable")
    r = t["r_multiple_net"].to_numpy(dtype="float64")
    pnl = t["pnl_usdt"].to_numpy(dtype="float64")
    exit_ms = _ms(t["exit_time"])
    entry_ms = _ms(t["entry_time"])
    st = cfg["stats"]
    if rng is None:
        rng = np.random.default_rng(cfg["seed"])
    ci_low, ci_high = bootstrap_ci(r, st["bootstrap_resamples"], cfg["verdict"]["ci_level"], rng)
    final = initial + pnl.sum()
    dd_pct = 100.0 * max_drawdown(np.cumsum(pnl), initial, relative=True)
    # daily returns on realised equity over every calendar day of the period
    n_days = int(np.ceil((end_ms - start_ms) / DAY_MS))
    daily_pnl = np.bincount(((exit_ms - start_ms) // DAY_MS).astype("int64"), weights=pnl, minlength=n_days)[:n_days]
    equity_start = initial + np.concatenate(([0.0], np.cumsum(daily_pnl)[:-1]))
    with np.errstate(divide="ignore", invalid="ignore"):
        daily_ret = np.where(equity_start > 0, daily_pnl / equity_start, 0.0)
    sd = daily_ret.std(ddof=1) if n_days > 1 else 0.0
    sharpe = float(daily_ret.mean() / sd * np.sqrt(365.0)) if sd > 0 else float("nan")
    years = (end_ms - start_ms) / (365.25 * DAY_MS)
    cagr = (final / initial) ** (1.0 / years) - 1.0 if final > 0 and years > 0 else -1.0
    calmar = float(100.0 * cagr / dd_pct) if dd_pct > 0 else float("nan")
    costs = float((t["fees"] + t["slippage"] + t["funding"]).sum())
    gross = float(pnl.sum() + costs)
    out.update({
        "win_rate": float((r > 0).mean()),
        "expectancy_r": float(r.mean()),
        "median_r": float(np.median(r)),
        "profit_factor": profit_factor(r),
        "ci_low": ci_low, "ci_high": ci_high,
        "max_dd_pct": dd_pct,
        "max_dd_r": max_drawdown(np.cumsum(r), 0.0, relative=False),
        "sharpe": sharpe, "calmar": calmar,
        "longest_losing_streak": longest_losing_streak(r),
        "avg_hold_hours": float((exit_ms - entry_ms).mean() / 3_600_000.0),
        "time_in_position_pct": time_in_position_pct(entry_ms, exit_ms, start_ms, end_ms),
        "total_return_pct": 100.0 * (final / initial - 1.0),
        "sum_r": float(r.sum()),
        "gross_pnl": gross, "costs_total": costs,
        "cost_share_of_gross": costs / gross if gross > 0 else float("nan"),
        "final_capital": float(final),
    })
    return out


# ---------------------------------------------------------------- breakdowns

def breakdowns(trades: pd.DataFrame) -> pd.DataFrame:
    """Long table: dimension (pair / direction / quarter / exit), key, n, expectancy, sum of R, win rate."""
    cols = ["dimension", "key", "n", "expectancy_r", "sum_r", "win_rate"]
    if len(trades) == 0:
        return pd.DataFrame(columns=cols)
    t = trades.copy()
    et = t["entry_time"].dt.tz_convert("UTC").dt.tz_localize(None)
    t["quarter"] = et.dt.year.astype(str) + "-T" + et.dt.quarter.astype(str)
    frames = []
    for dim, col in (("pair", "symbole"), ("direction", "direction"), ("quarter", "quarter"), ("exit", "exit_reason")):
        g = t.groupby(col, sort=True)["r_multiple_net"]
        df = pd.DataFrame({"n": g.size(), "expectancy_r": g.mean(), "sum_r": g.sum(),
                           "win_rate": g.apply(lambda x: float((x > 0).mean()))}).reset_index()
        df = df.rename(columns={col: "key"})
        df.insert(0, "dimension", dim)
        frames.append(df)
    return pd.concat(frames, ignore_index=True)[cols]


# ---------------------------------------------------------------- selection (section 7)

def passes_dev(metrics: dict, cfg: dict) -> bool:
    sel = cfg["selection"]
    return bool(metrics["n_trades"] >= sel["dev_min_trades"]
                and metrics["expectancy_r"] > sel["dev_min_expectancy_r"]
                and metrics["profit_factor"] > sel["dev_min_profit_factor"])


def plateau_share(neighbour_expectancies: list[float]) -> float:
    """Share of direct neighbours with a strictly positive expectancy (NaN / no trade counts as not positive)."""
    if not neighbour_expectancies:
        return 0.0
    good = sum(1 for e in neighbour_expectancies if e is not None and np.isfinite(e) and e > 0)
    return good / len(neighbour_expectancies)


# ---------------------------------------------------------------- verdict (section 9)

CRITERIA = ["c1_trades", "c2_expectancy_pf", "c3_ci_low", "c4_costs_x2", "c5_baseline", "c6_without_best_pair",
            "c7_pairs_positive", "c8_drawdown", "c9_quarters"]


def verdict_details(trades: pd.DataFrame, metrics: dict, expectancy_costs_x2: float, baseline_p95: float,
                    cfg: dict) -> dict:
    """Evaluate the nine immutable criteria on one set. Returns values, booleans and the verdict."""
    v = cfg["verdict"]
    r = trades["r_multiple_net"].to_numpy(dtype="float64") if len(trades) else np.zeros(0)
    out: dict = {}
    out["c1_trades"] = bool(metrics["n_trades"] >= v["min_trades"])
    out["c2_expectancy_pf"] = bool(len(r) and metrics["expectancy_r"] >= v["min_expectancy_r"]
                                   and metrics["profit_factor"] >= v["min_profit_factor"])
    out["c3_ci_low"] = bool(len(r) and metrics["ci_low"] > 0)
    out["expectancy_costs_x2"] = expectancy_costs_x2
    out["c4_costs_x2"] = bool(np.isfinite(expectancy_costs_x2) and expectancy_costs_x2 > 0)
    out["baseline_p95"] = baseline_p95
    out["c5_baseline"] = bool(len(r) and np.isfinite(baseline_p95) and metrics["expectancy_r"] > baseline_p95)
    if len(r):
        by_pair = trades.groupby("symbole")["r_multiple_net"].agg(["size", "mean", "sum"])
        best = by_pair["sum"].idxmax()
        rest = trades[trades["symbole"] != best]["r_multiple_net"]
        out["best_pair"] = best
        out["expectancy_without_best_pair"] = float(rest.mean()) if len(rest) else float("nan")
        big = by_pair[by_pair["size"] >= v["min_trades_per_pair"]]
        out["pairs_with_min_trades"] = int(len(big))
        out["share_pairs_positive"] = float((big["mean"] > 0).mean()) if len(big) else float("nan")
        et = trades["entry_time"].dt.tz_convert("UTC").dt.tz_localize(None)
        q = trades.groupby(et.dt.year * 10 + et.dt.quarter)["r_multiple_net"].mean()
        out["quarters"] = int(len(q))
        out["share_bad_quarters"] = float((q < v["bad_quarter_threshold_r"]).mean())
    else:
        out.update(best_pair="", expectancy_without_best_pair=float("nan"), pairs_with_min_trades=0,
                   share_pairs_positive=float("nan"), quarters=0, share_bad_quarters=float("nan"))
    out["c6_without_best_pair"] = bool(np.isfinite(out["expectancy_without_best_pair"])
                                       and out["expectancy_without_best_pair"] > 0)
    out["c7_pairs_positive"] = bool(np.isfinite(out["share_pairs_positive"])
                                    and out["share_pairs_positive"] >= v["min_share_pairs_positive"])
    out["c8_drawdown"] = bool(metrics["max_dd_pct"] <= v["max_drawdown_pct"])
    out["c9_quarters"] = bool(np.isfinite(out["share_bad_quarters"])
                              and out["share_bad_quarters"] <= v["max_share_bad_quarters"] + 1e-9)
    failed = [c for c in CRITERIA if not out[c]]
    out["criteria_failed"] = ",".join(c.split("_")[0] for c in failed)
    if not out["c1_trades"]:
        out["verdict"] = "INSUFFISANT"
    elif failed:
        out["verdict"] = "REJETE"
    else:
        out["verdict"] = "PASSE"
    return out


# ---------------------------------------------------------------- buy & hold context

def buy_and_hold(close: np.ndarray) -> tuple[float, float]:
    """(total return %, max drawdown %) of holding the asset over the given closes."""
    if len(close) < 2:
        return float("nan"), float("nan")
    ret = 100.0 * (close[-1] / close[0] - 1.0)
    peak = np.maximum.accumulate(close)
    dd = 100.0 * float(((peak - close) / peak).max())
    return float(ret), dd
