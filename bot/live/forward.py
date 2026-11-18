"""Final test on forward data (criterion 10, PROTOCOLE_PHASE4.md section 3).

Before a variant reaches the thresholds (100 closed signals AND 3 months), only COUNTS are shown: looking at the
forward performance earlier would turn the final test into another validation. When the thresholds are reached the
test is computed once and its result frozen in ``validated.json`` (pass) or in the state (fail).
"""
from __future__ import annotations

import json

import numpy as np
from scipy import stats

from ..core.config import REPO_DIR
from ..core.timeutil import DAY_MS, ms_to_str, to_ms
from .scanner import load_list
from .state import StateStore


def write_forward_report(cfg: dict) -> str:
    lc = cfg["live"]
    state = StateStore(cfg)
    observed = load_list(lc["observation_list"])
    sig = state.signals()
    st = state.status()
    j = sig.merge(st, left_on="id", right_on="signal_id", how="left") if len(sig) else sig
    start = to_ms(lc["start"])
    lines = ["# Test final (données futures)\n", f"Observation depuis le {ms_to_str(start, '%Y-%m-%d')}.\n",
             "| Variante | Signaux | Clos | Mois d'observation | Statut |", "|---|---|---|---|---|"]
    validated = load_list(lc["validated_list"])
    for v in observed:
        vid = v["variant"]
        d = j[j["variant"] == vid] if len(j) else j
        closed = d[d["status"].isin(["sorti en gain", "sorti en perte"])] if len(d) else d
        months = (int(state.get("last_scan_ms") or start) - start) / (30.44 * DAY_MS)
        done = state.get(f"final_test:{vid}")
        if done:
            status = done
        elif len(closed) >= int(cfg["final_test"]["min_trades"]) and months >= int(cfg["final_test"]["min_months"]):
            r = closed.sort_values("exit_time")["r_multiple"].to_numpy(dtype="float64")
            mean, se = float(r.mean()), float(r.std(ddof=1) / np.sqrt(len(r)))
            t = (mean - float(v["oos_expectancy_r"])) / se if se > 0 else 0.0
            inferior = stats.norm.cdf(t) < 0.05
            ok = mean > 0 and not inferior
            status = (f"EDGE CONFIRMÉ (E[R] {mean:+.3f}, validation {v['oos_expectancy_r']:+.3f})" if ok else
                      f"ÉCHEC (E[R] {mean:+.3f}, validation {v['oos_expectancy_r']:+.3f})")
            state.put(f"final_test:{vid}", status)
            if ok:
                validated.append({"variant": vid, "concept": v["concept"], "params": v["params"], "forward_expectancy_r": mean,
                                  "forward_trades": int(len(r))})
                (REPO_DIR / lc["validated_list"]).write_text(json.dumps(validated, indent=1) + "\n", encoding="utf-8")
        else:
            status = "en attente (performance masquée jusqu'aux seuils)"
        lines.append(f"| {vid} | {len(d)} | {len(closed)} | {months:.1f} | {status} |")
    out = REPO_DIR / "bot" / "reports" / "FORWARD.md"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(out)
