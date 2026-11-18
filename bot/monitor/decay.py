"""Anti-degradation monitor (Step 10).

A concept variant is disabled automatically (and an alert is raised) when:
* the rolling expectancy of its last ``rolling_n`` closed signals is negative, or
* its live drawdown exceeds ``dd_mult`` x the out-of-sample drawdown measured in the backtest.
"""
from __future__ import annotations

import numpy as np


def live_drawdown_r(r_multiples: list[float]) -> float:
    """Largest peak-to-trough decline of the cumulative R curve (in R)."""
    if not r_multiples:
        return 0.0
    eq = np.concatenate(([0.0], np.cumsum(r_multiples)))
    return float((np.maximum.accumulate(eq) - eq).max())


def check(r_multiples: list[float], backtest_dd_r: float, cfg_mon: dict) -> tuple[bool, str]:
    """(still enabled, reason). ``r_multiples`` in closing order."""
    n = int(cfg_mon["rolling_n"])
    if len(r_multiples) >= n:
        e = float(np.mean(r_multiples[-n:]))
        if e < 0:
            return False, f"espérance glissante sur {n} signaux négative ({e:+.3f} R)"
    dd = live_drawdown_r(r_multiples)
    if backtest_dd_r > 0 and dd > float(cfg_mon["dd_mult"]) * backtest_dd_r:
        return False, f"drawdown live {dd:.1f} R > {cfg_mon['dd_mult']} × drawdown du backtest ({backtest_dd_r:.1f} R)"
    return True, "ok"
