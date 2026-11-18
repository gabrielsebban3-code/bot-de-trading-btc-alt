"""Statistical tests against data snooping (Step 7.4).

* Probabilistic and Deflated Sharpe Ratio (Bailey & López de Prado, 2014).
* Hansen's SPA test through the ``arch`` library (stationary bootstrap).
"""
from __future__ import annotations

import math

import numpy as np
from scipy import stats

EULER_GAMMA = 0.5772156649015329


def probabilistic_sharpe(sr: float, sr_benchmark: float, n_obs: int, skew: float, kurt: float) -> float:
    """P(true SR > benchmark) for a per-period Sharpe ``sr`` estimated on ``n_obs`` observations.

    ``kurt`` is the (non-excess) kurtosis: 3 for a normal distribution.
    """
    if n_obs < 2:
        return float("nan")
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr ** 2
    if denom <= 0:
        return float("nan")
    z = (sr - sr_benchmark) * math.sqrt(n_obs - 1) / math.sqrt(denom)
    return float(stats.norm.cdf(z))


def expected_max_sharpe(n_trials: int, var_sr: float) -> float:
    """Expected maximum of ``n_trials`` per-period Sharpe ratios under the null (true SR = 0)."""
    if n_trials < 2 or var_sr <= 0:
        return 0.0
    a = stats.norm.ppf(1.0 - 1.0 / n_trials)
    b = stats.norm.ppf(1.0 - 1.0 / (n_trials * math.e))
    return float(math.sqrt(var_sr) * ((1.0 - EULER_GAMMA) * a + EULER_GAMMA * b))


def deflated_sharpe(returns: np.ndarray, n_trials: int, var_sr_trials: float) -> dict:
    """DSR of a series of per-period returns, given the number of trials and the variance of their Sharpes.

    ``var_sr_trials``: variance of the per-period Sharpe ratios across all tested variants (same frequency).
    """
    r = np.asarray(returns, dtype="float64")
    r = r[np.isfinite(r)]
    n = len(r)
    if n < 3 or r.std(ddof=1) == 0:
        return {"sr": float("nan"), "sr0": float("nan"), "dsr": float("nan"), "n_obs": n}
    sr = float(r.mean() / r.std(ddof=1))
    skew = float(stats.skew(r))
    kurt = float(stats.kurtosis(r, fisher=False))
    sr0 = expected_max_sharpe(n_trials, var_sr_trials)
    return {"sr": sr, "sr0": sr0, "dsr": probabilistic_sharpe(sr, sr0, n, skew, kurt), "n_obs": n,
            "skew": skew, "kurtosis": kurt, "n_trials": n_trials}


def spa_test(benchmark: np.ndarray, models: np.ndarray, reps: int = 2000, block: int = 20,
             seed: int = 42) -> dict:
    """Hansen's SPA: H0 = no model beats the benchmark. Inputs are per-period LOSSES (lower is better).

    ``benchmark``: (T,) losses of the benchmark (e.g. 0 = staying flat);
    ``models``: (T, k) losses of every tested variant (e.g. minus the daily returns).
    """
    from arch.bootstrap import SPA
    models = np.asarray(models, dtype="float64")
    benchmark = np.asarray(benchmark, dtype="float64")
    keep = (models - benchmark[:, None]).std(axis=0) > 0      # variants without any trade are not tested
    if not keep.any():
        return {"p_lower": float("nan"), "p_consistent": float("nan"), "p_upper": float("nan"), "n_models": 0}
    models = models[:, keep]
    spa = SPA(benchmark, models,
              reps=reps, block_size=block, bootstrap="stationary", studentize=True, nested=False,
              seed=seed)
    spa.compute()
    pv = spa.pvalues
    return {"p_lower": float(pv["lower"]), "p_consistent": float(pv["consistent"]), "p_upper": float(pv["upper"]),
            "n_models": int(keep.sum()), "n_dropped": int((~keep).sum())}
