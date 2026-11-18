"""Markdown + PNG report of a tournament phase (Step 7)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ..core.timeutil import ms_to_str

CRIT_LABELS = {
    "c1_trades": "≥ 100 trades", "c2_ci_low": "IC 95 % > 0", "c3_spa": "SPA p < 0,05", "c4_dsr": "DSR > 0,95",
    "c5_baseline": "> 95e centile hasard", "c6_costs": "coûts × 1,5 > 0", "c7_neighbours": "voisines ≥ 75 %",
    "c8_years": "stabilité annuelle",
}
DIR_FR = {"long": "long", "short": "short", "both": "long + short"}


def _f(x, nd=3, pct=False, sign=False):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return "–"
    s = f"{x:+.{nd}f}" if sign else f"{x:.{nd}f}"
    s = s.replace(".", ",")
    return s + (" %" if pct else "")


def _table(headers, rows) -> str:
    out = "| " + " | ".join(headers) + " |\n|" + "---|" * len(headers) + "\n"
    return out + "\n".join("| " + " | ".join(str(c) for c in r) + " |" for r in rows) + "\n"


def _plot(res: dict, out_dir: Path) -> list[str]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    files = []
    init = 10000.0
    for concept in ("C1", "C2"):
        rs = [r for r in res["results"] if r["concept"] == concept]
        if not rs:
            continue
        fig, axes = plt.subplots(1, 3, figsize=(16, 4.5), sharey=False)
        for ax, tf in zip(axes, ("1h", "4h", "1d")):
            for r in rs:
                if r["tf"] != tf or r["oos"].empty:
                    continue
                t = r["oos"].sort_values("exit_time")
                eq = init + t["pnl"].cumsum().to_numpy()
                x = pd.to_datetime(t["exit_time"].to_numpy(), unit="ms")
                ax.plot(x, eq / init, label=DIR_FR[r["direction"]])
            for name, b in res["benchmarks"].items():
                if name.startswith("BTC"):
                    ax.plot(pd.to_datetime(b["curve"][0], unit="ms"), b["curve"][1], color="grey", lw=0.8,
                            ls="--", label=name)
            ax.axhline(1.0, color="black", lw=0.5)
            ax.set_title(f"{concept} {tf} (hors échantillon, 2022-2026)")
            ax.set_yscale("log")
            ax.legend(fontsize=8)
        fig.tight_layout()
        name = f"equity_{concept}.png"
        fig.savefig(out_dir / name, dpi=110)
        plt.close(fig)
        files.append(name)
    return files


def write_phase2_report(res: dict, out_dir: Path, cfg: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    res["trials"].to_csv(out_dir / "trials.csv", index=False)
    rows_csv = []
    for r in res["results"]:
        m = r["metrics"]
        rows_csv.append({"group": r["group"], "status": r["status"], "n": m["n_trades"],
                         "expectancy_r": m.get("expectancy_r"), "ci_low": m.get("ci_low"), "ci_high": m.get("ci_high"),
                         "profit_factor": m.get("profit_factor"), "win_rate": m.get("win_rate"),
                         "sharpe": m.get("sharpe"), "sortino": m.get("sortino"), "max_dd_pct": m.get("max_dd_pct"),
                         "dd_days": m.get("dd_days"), "e_costs_x1_5": r["e_stress"],
                         "baseline_p95": r["baseline"]["p95"], "baseline_percentile": r["baseline"]["percentile"],
                         "share_neighbours_positive": r["share_neighbours"], "dsr": r["dsr"]["dsr"],
                         "main_variant": r["main_variant"], **{k: v for k, v in r["criteria"].items()}})
        if len(r["oos"]):
            r["oos"].to_csv(out_dir / f"oos_{r['group'].replace('|', '_')}.csv", index=False)
    pd.DataFrame(rows_csv).to_csv(out_dir / "summary.csv", index=False)
    figs = _plot(res, out_dir)
    L = []
    L.append("# Rapport Phase 2 : C1 (cassure de tendance) et C2 (repli dans la tendance), BTC et ETH\n")
    L.append(f"Protocole : `PROTOCOLE_PHASE2.md` (committé avant le calcul). Validation hors échantillon en "
             f"walk-forward du {ms_to_str(res['wf_start'], '%Y-%m-%d')} au {ms_to_str(res['wf_end'] - 1, '%Y-%m-%d')}. "
             f"Tous les chiffres sont nets de frais (taker 0,05 %), de slippage (modèle ATR + volume) et du funding réel. "
             f"Risque 1 % par trade.\n")
    cand = [r for r in res["results"] if r["status"].startswith("candidat")]
    pos = [r for r in res["results"] if np.isfinite(r["metrics"].get("expectancy_r", np.nan)) and r["metrics"]["expectancy_r"] > 0]
    L.append("## Verdict\n")
    if cand:
        L.append(f"**{len(cand)} groupe(s) passent les critères 1 à 8 et deviennent candidats pour la Phase 3** : "
                 + ", ".join(f"`{r['group']}`" for r in cand) + ". Ce n'est pas un « edge confirmé » : il manque les paires "
                 "mises de côté et le test final.\n")
    else:
        L.append("**Aucun groupe ne passe les critères 1 à 8. Aucun candidat C1 ou C2 sur BTC et ETH.**\n")
    L.append(f"- Groupes à espérance hors échantillon positive : {len(pos)} sur {len(res['results'])}.")
    L.append(f"- Essais comptés : {len(res['trials'])} dans cette phase ({(res['trials']['kind'] == 'grid').sum()} variantes de la "
             f"grille + {(res['trials']['kind'] != 'grid').sum()} pour l'ablation du volume), **{res['n_trials_total']} au total** "
             f"avec les 232 hérités.")
    spa = res["spa"]
    L.append(f"- Test SPA de Hansen (toutes les variantes de la grille contre « rester à plat », rendements journaliers "
             f"2022-2026) : p = {_f(spa['p_consistent'])} (p inférieur = {_f(spa['p_lower'])}, supérieur = {_f(spa['p_upper'])}). "
             + ("La meilleure variante bat significativement le fait de ne rien faire." if spa["p_consistent"] < 0.05 else
                "On ne peut pas exclure que la meilleure variante soit due au hasard du choix parmi toutes celles testées."))
    flags = [(r["group"], r["suspicious"]) for r in res["results"] if r["suspicious"]]
    L.append(f"- Résultats suspects (règle 6) : {', '.join(f'{g} ({', '.join(f)})' for g, f in flags) if flags else 'aucun'}.\n")
    # main table
    hdr = ["Groupe", "Trades", "E[R]", "IC 95 %", "PF", "Gagnants", "Sharpe", "DD max", "Coûts × 1,5", "Hasard p95",
           "Voisines +", "DSR", "Critères ratés", "Statut"]
    rows = []
    for r in sorted(res["results"], key=lambda x: (x["concept"], ["1h", "4h", "1d"].index(x["tf"]), x["direction"])):
        m = r["metrics"]
        failed = [CRIT_LABELS[k] for k, v in r["criteria"].items() if not v]
        rows.append([f"{r['concept']} {r['tf']} {DIR_FR[r['direction']]}", m["n_trades"], _f(m.get("expectancy_r"), sign=True),
                     f"[{_f(m.get('ci_low'), sign=True)} ; {_f(m.get('ci_high'), sign=True)}]", _f(m.get("profit_factor"), 2),
                     _f(100 * m["win_rate"], 1, pct=True) if m["n_trades"] else "–", _f(m.get("sharpe"), 2),
                     _f(m.get("max_dd_pct"), 1, pct=True), _f(r["e_stress"], sign=True), _f(r["baseline"]["p95"], sign=True),
                     _f(100 * r["share_neighbours"], 0, pct=True) if np.isfinite(r["share_neighbours"]) else "–",
                     _f(r["dsr"]["dsr"], 2), "; ".join(failed) or "aucun", f"**{r['status']}**"])
    L.append("## Classement hors échantillon (walk-forward)\n")
    L.append(_table(hdr, rows))
    L.append("E[R] = gain moyen par trade en multiples du risque, après tous les coûts. Hasard p95 = 95e centile de "
             "l'espérance d'entrées aléatoires avec les mêmes stops, la même sortie et les mêmes coûts. Voisines + = part des "
             "variantes à paramètres ±20 % qui restent positives. DSR = Deflated Sharpe Ratio, probabilité que le Sharpe "
             f"soit réel compte tenu des {res['n_trials_total']} essais.\n")
    bm = res["benchmarks"]
    L.append("## Référence : détention passive sur la même période\n")
    L.append(_table(["Référence", "Rendement", "Sharpe", "Drawdown max"],
                    [[k, _f(v["total_return_pct"], 1, pct=True), _f(v["sharpe"], 2), _f(v["max_dd_pct"], 1, pct=True)]
                     for k, v in bm.items()]))
    for f in figs:
        L.append(f"![{f}]({f})\n")
    # details per group with trades
    L.append("## Détail par groupe\n")
    for r in sorted(res["results"], key=lambda x: (x["concept"], ["1h", "4h", "1d"].index(x["tf"]), x["direction"])):
        m, o = r["metrics"], r["oos"]
        L.append(f"### {r['concept']} {r['tf']} {DIR_FR[r['direction']]} : {r['status']}\n")
        sel = [s for s in r["selections"]]
        L.append("Variante retenue par fenêtre : " + "; ".join(
            f"{ms_to_str(s['test_start'], '%Y-%m')} → {(s['variant'] or 'aucune (moins de 10 trades au réglage)').replace(r['concept'] + '_', '')}"
            for s in sel) + ".\n")
        if o.empty:
            L.append("Aucun trade hors échantillon.\n")
            continue
        L.append(f"- {m['n_trades']} trades, espérance {_f(m['expectancy_r'], sign=True)} R, profit factor {_f(m['profit_factor'], 2)}, "
                 f"{_f(100 * m['win_rate'], 1, pct=True)} de gagnants, Sharpe {_f(m['sharpe'], 2)}, Sortino {_f(m['sortino'], 2)}, "
                 f"drawdown max {_f(m['max_dd_pct'], 1, pct=True)} (durée {m['dd_days']} jours), plus longue série de pertes "
                 f"{m['longest_losing_streak']}, durée moyenne {_f(m['avg_hold_hours'] / 24, 1)} jours, rendement "
                 f"{_f(m['total_return_pct'], 1, pct=True)}, coûts = {_f(100 * m['costs_share_of_gross'], 0, pct=True) if np.isfinite(m.get('costs_share_of_gross', np.nan)) else '–'} du gain brut.")
        b = r["baseline"]
        L.append(f"- Hasard (même sortie) : médiane {_f(b['median'], sign=True)} R, 95e centile {_f(b['p95'], sign=True)} R ; "
                 f"le groupe est au {_f(b['percentile'], 0)}e centile.")
        if r["ablation"] is not None:
            L.append(f"- Ablation du filtre volume relatif > 1,2 : {r['ablation']['n']} trades, espérance "
                     f"{_f(r['ablation']['expectancy'], sign=True)} R (sans filtre : {_f(m['expectancy_r'], sign=True)} R) → "
                     + ("le filtre améliore le résultat." if np.isfinite(r['ablation']['expectancy']) and r['ablation']['expectancy'] > m['expectancy_r'] else "le filtre n'améliore pas : retiré."))
        y = r["years"]["table"]
        L.append("- Par année : " + "; ".join(f"{p} {_f(s, 1, sign=True)} R ({int(n)})" for p, n, s in
                                              zip(y["period"], y["n"], y["sum_r"])) + ".")
        g = o.groupby("symbol")["r_multiple"].agg(["size", "mean"])
        L.append("- Par paire : " + "; ".join(f"{s} {_f(v['mean'], sign=True)} R ({int(v['size'])})" for s, v in g.iterrows()) + ".")
        g = o.groupby("direction")["r_multiple"].agg(["size", "mean"])
        L.append("- Par sens : " + "; ".join(f"{s} {_f(v['mean'], sign=True)} R ({int(v['size'])})" for s, v in g.iterrows()) + ".")
        g = o.groupby("exit_reason")["r_multiple"].agg(["size", "mean"])
        L.append("- Par sortie : " + "; ".join(f"{s} {_f(v['mean'], sign=True)} R ({int(v['size'])})" for s, v in g.iterrows()) + ".")
        rg = r["regimes"]
        if len(rg):
            g1 = rg.groupby("regime")["r_multiple"].agg(["size", "mean"])
            g2 = rg.groupby("high_vol")["r_multiple"].agg(["size", "mean"])
            L.append("- Par régime à l'entrée : " + "; ".join(f"{s} {_f(v['mean'], sign=True)} R ({int(v['size'])})" for s, v in g1.iterrows())
                     + " ; forte volatilité : " + "; ".join(f"{'oui' if s else 'non'} {_f(v['mean'], sign=True)} R ({int(v['size'])})"
                                                           for s, v in g2.iterrows()) + ".")
        q = pd.to_datetime(o["entry_time"], unit="ms").dt.to_period("Q").astype(str)
        gq = o.assign(q=q).groupby("q")["r_multiple"].agg(["size", "sum"])
        L.append("- Par trimestre (somme de R) : " + "; ".join(f"{p} {_f(v['sum'], 1, sign=True)}" for p, v in gq.iterrows()) + ".\n")
    L.append("## Toutes les variantes, période 2022-2026 à paramètres fixes (information, pas une validation)\n")
    t = res["trials"][res["trials"]["kind"] == "grid"].copy()
    t = t.sort_values("expectancy_2022_2026", ascending=False)
    L.append(_table(["Variante", "Trades", "E[R]", "PF", "Sharpe"],
                    [[r.variant, int(r.n_2022_2026), _f(r.expectancy_2022_2026, sign=True), _f(r.pf_2022_2026, 2),
                      _f(r.sharpe_2022_2026, 2)] for r in t.itertuples()]))
    L.append("Choisir la meilleure ligne de ce tableau serait de la sélection après coup : seul le walk-forward compte.\n")
    path = out_dir / "PHASE2.md"
    path.write_text("\n".join(L) + "\n", encoding="utf-8")
    return path
