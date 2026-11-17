"""Performance metrics of a trade list (Step 7.2). All inputs are net of fees, slippage and funding."""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..core.timeutil import DAY_MS


def profit_factor(r: np.ndarray) -> float:
    gains, losses = r[r > 0].sum(), -r[r < 0].sum()
    if losses == 0:
        return float("inf") if gains > 0 else float("nan")
    return float(gains / losses)


def bootstrap_mean_ci(r: np.ndarray, n_resamples: int, level: float, rng: np.random.Generator) -> tuple[float, float]:
    """Percentile bootstrap interval of the mean (trades resampled with replacement)."""
    n = len(r)
    if n == 0:
        return float("nan"), float("nan")
    means = np.empty(n_resamples)
    chunk = max(1, min(n_resamples, 4_000_000 // n))
    done = 0
    while done < n_resamples:
        m = min(chunk, n_resamples - done)
        means[done:done + m] = r[rng.integers(0, n, size=(m, n))].mean(axis=1)
        done += m
    a = (1.0 - level) / 2.0
    lo, hi = np.quantile(means, [a, 1.0 - a])
    return float(lo), float(hi)


def max_drawdown(equity: np.ndarray) -> tuple[float, int]:
    """(largest relative peak-to-trough decline, index length of the longest drawdown)."""
    if len(equity) == 0:
        return 0.0, 0
    peak = np.maximum.accumulate(equity)
    dd = np.where(peak > 0, (peak - equity) / peak, 0.0)
    longest = cur = 0
    for x in dd:
        cur = cur + 1 if x > 0 else 0
        longest = max(longest, cur)
    return float(dd.max()), int(longest)


def longest_losing_streak(r: np.ndarray) -> int:
    best = cur = 0
    for x in r:
        cur = cur + 1 if x < 0 else 0
        best = max(best, cur)
    return best


def daily_returns(trades: pd.DataFrame, initial: float, start_ms: int, end_ms: int) -> np.ndarray:
    """Daily returns of the realised equity over every calendar day of [start, end)."""
    n_days = int(np.ceil((end_ms - start_ms) / DAY_MS))
    if trades.empty:
        return np.zeros(n_days)
    ex = trades["exit_time"].to_numpy(dtype="int64")
    pnl = trades["pnl"].to_numpy(dtype="float64")
    day = np.clip((ex - start_ms) // DAY_MS, 0, n_days - 1).astype("int64")
    daily_pnl = np.bincount(day, weights=pnl, minlength=n_days)[:n_days]
    eq_start = initial + np.concatenate(([0.0], np.cumsum(daily_pnl)[:-1]))
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(eq_start > 0, daily_pnl / eq_start, 0.0)


def compute_metrics(trades: pd.DataFrame, initial: float, start_ms: int, end_ms: int,
                    rng: np.random.Generator | None = None, n_boot: int = 10000, level: float = 0.95) -> dict:
    n = len(trades)
    out: dict = {"n_trades": n}
    if n == 0:
        out.update(win_rate=np.nan, expectancy_r=np.nan, profit_factor=np.nan, ci_low=np.nan, ci_high=np.nan,
                   max_dd_pct=0.0, dd_days=0, sharpe=np.nan, sortino=np.nan, longest_losing_streak=0,
                   avg_hold_hours=np.nan, total_return_pct=0.0, sum_r=0.0, costs_share_of_gross=np.nan)
        return out
    t = trades.sort_values(["exit_time", "entry_time", "symbol"], kind="stable")
    r = t["r_multiple"].to_numpy(dtype="float64")
    pnl = t["pnl"].to_numpy(dtype="float64")
    rng = rng or np.random.default_rng(42)
    lo, hi = bootstrap_mean_ci(r, n_boot, level, rng)
    equity = np.concatenate(([initial], initial + np.cumsum(pnl)))
    dd, _ = max_drawdown(equity)
    dr = daily_returns(t, initial, start_ms, end_ms)
    eq_daily = initial * np.cumprod(1.0 + dr)
    _, dd_days = max_drawdown(np.concatenate(([initial], eq_daily)))
    sd = dr.std(ddof=1) if len(dr) > 1 else 0.0
    downside = np.sqrt(np.mean(np.minimum(dr, 0.0) ** 2)) if len(dr) else 0.0
    costs = float((t["fees"] + t["slippage_cost"] + t["funding"]).sum())
    gross = float(pnl.sum() + costs)
    out.update(
        win_rate=float((r > 0).mean()),
        expectancy_r=float(r.mean()),
        median_r=float(np.median(r)),
        profit_factor=profit_factor(r),
        ci_low=lo, ci_high=hi,
        max_dd_pct=100.0 * dd,
        dd_days=dd_days,
        sharpe=float(dr.mean() / sd * np.sqrt(365.0)) if sd > 0 else np.nan,
        sortino=float(dr.mean() / downside * np.sqrt(365.0)) if downside > 0 else np.nan,
        longest_losing_streak=longest_losing_streak(r),
        avg_hold_hours=float(((t["exit_time"] - t["entry_time"]) / 3_600_000).mean()),
        total_return_pct=100.0 * pnl.sum() / initial,
        sum_r=float(r.sum()),
        costs_total=costs,
        costs_share_of_gross=costs / gross if gross > 0 else np.nan,
    )
    return out


def suspicious(m: dict) -> list[str]:
    """Rule 6: results that must be treated as bugs until proven otherwise."""
    flags = []
    if m.get("n_trades", 0) >= 30:
        if m.get("win_rate", 0) > 0.70:
            flags.append("win rate > 70 %")
        if m.get("profit_factor", 0) > 3.0:
            flags.append("profit factor > 3")
        if (m.get("sharpe") or 0) > 2.5:
            flags.append("Sharpe > 2.5")
    return flags


def by_period(trades: pd.DataFrame, freq: str = "Y") -> pd.DataFrame:
    """Sum and mean of R per calendar year ('Y') or quarter ('Q') of the entry date."""
    if trades.empty:
        return pd.DataFrame(columns=["period", "n", "mean_r", "sum_r"])
    per = pd.to_datetime(trades["entry_time"], unit="ms", utc=True).dt.tz_localize(None).dt.to_period(freq).astype(str)
    g = trades.assign(period=per).groupby("period")["r_multiple"]
    return pd.DataFrame({"n": g.size(), "mean_r": g.mean(), "sum_r": g.sum()}).reset_index()
