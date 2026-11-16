"""Study 4 report: rapport.md and its charts, built only from the result files."""
from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from . import data, etude4, run  # noqa: E402

PREVIOUS_CONFIGS = 133                       # studies 1 to 3, same pairs and years
INK, INK2, MUTED, GRID, AXIS, SURFACE, BLUE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb", "#2a78d6"
LABELS = {"c1_trades": "≥ 200 trades", "c2_expectancy": "espérance > 0,15 R", "c3_profit_factor": "profit factor > 1,3",
          "c4_drawdown": "drawdown < 25 %", "c5_pairs": "≥ 60 % des paires positives", "c6_monte_carlo": "Monte Carlo ≥ 95 %",
          "c7_baseline": "mieux que le hasard", "c8_buy_hold": "mieux que le buy & hold"}


def _f(x, n=3, sign=True):
    if x is None or not np.isfinite(x):
        return "—"
    return (f"{x:+.{n}f}" if sign else f"{x:.{n}f}").replace(".", ",")


def _table(head, rows, align=None):
    align = align or ["---"] * len(head)
    return "\n".join(["| " + " | ".join(head) + " |", "|" + "|".join(align) + "|"] +
                     ["| " + " | ".join(str(c) for c in r) + " |" for r in rows])


def _style(ax):
    ax.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelsize=8, length=0)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)


def _curves(cfg, sel, sets):
    """Small multiples: cumulative result in R of each method's kept variant, one panel per method."""
    fams = [f for f, e in sel["methods"].items() if e.get("selected")]
    if not fams:
        return None
    cols = 2
    rows = int(np.ceil(len(fams) / cols))
    fig, axes = plt.subplots(rows, cols, figsize=(11, 2.6 * rows), facecolor=SURFACE, squeeze=False)
    bounds = {s: data.set_bounds_ms(cfg, s) for s in sets}
    for ax, fam in zip(axes.ravel(), fams):
        e = sel["methods"][fam]
        t = pd.concat([pd.read_csv(run.trades_path(e["selected"], s), parse_dates=["exit_time"]) for s in sets])
        t = t.sort_values("exit_time")
        _style(ax)
        ax.axhline(0, color=AXIS, linewidth=1)
        if len(t):
            cum = t["r_multiple_net"].cumsum().to_numpy()
            ax.plot(t["exit_time"], cum, color=BLUE, linewidth=1.6)
            ax.annotate(f"{_f(cum[-1], 0)} R", (t["exit_time"].iloc[-1], cum[-1]), xytext=(4, 0),
                        textcoords="offset points", fontsize=8, color=INK, va="center")
        for s in sets[1:]:
            x = pd.Timestamp(bounds[s][0], unit="ms", tz="UTC")
            ax.axvline(x, color=MUTED, linewidth=0.8, linestyle=(0, (3, 3)))
            ax.annotate({"val": "validation", "test": "test final"}[s], (x, 1.0), xycoords=("data", "axes fraction"),
                        xytext=(3, -9), textcoords="offset points", fontsize=7.5, color=INK2)
        ax.set_title(f"{e['name']}\n{e['selected']}", fontsize=9, color=INK, loc="left")
        ax.xaxis.set_major_locator(mdates.YearLocator())
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
        ax.margins(x=0.08)
    for ax in axes.ravel()[len(fams):]:
        ax.set_visible(False)
    fig.suptitle("Résultat cumulé en R de la variante gardée pour chaque méthode (1 R = 1 % du capital risqué)",
                 fontsize=11, color=INK, x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    name = "courbes_methodes.png"
    fig.savefig(run.RESULTS / name, dpi=120, facecolor=SURFACE)
    plt.close(fig)
    return name


def _bars(cfg, sel, val):
    """Validation expectancy of each method's kept variant against the required threshold."""
    items = [(e["name"], float(val.loc[e["selected"], "expectancy_r"])) for e in sel["methods"].values() if e.get("selected")]
    if not items:
        return None
    items.sort(key=lambda x: x[1])
    thr = cfg["etude4"]["criteria"]["min_expectancy_r"]
    fig, ax = plt.subplots(figsize=(8.5, 0.5 * len(items) + 1.6), facecolor=SURFACE)
    _style(ax)
    ax.grid(axis="y", visible=False)
    ax.grid(axis="x", color=GRID, linewidth=0.6)
    y = np.arange(len(items))
    vals = [v for _, v in items]
    ax.barh(y, vals, height=0.55, color=BLUE)
    ax.axvline(0, color=AXIS, linewidth=1)
    ax.axvline(thr, color=INK2, linewidth=1, linestyle=(0, (4, 3)))
    ax.annotate(f"seuil exigé : {_f(thr, 2)} R", (thr, 0.0), xycoords=("data", "axes fraction"), xytext=(5, 6),
                textcoords="offset points", fontsize=8, color=INK2)
    for yi, v in zip(y, vals):
        ax.annotate(f"{_f(v)} R", (v, yi), xytext=(5 if v >= 0 else -5, 0), textcoords="offset points",
                    ha="left" if v >= 0 else "right", va="center", fontsize=8.5, color=INK)
    ax.set_yticks(y, [n for n, _ in items], fontsize=9, color=INK)
    span = max(abs(min(vals)), abs(max(vals)), thr) * 1.45
    ax.set_xlim(min(-span, min(vals) * 1.45), max(span * 0.6, thr * 1.9, max(vals) * 1.45))
    ax.set_xlabel("Espérance nette par trade sur la validation (R)", fontsize=8.5, color=INK2)
    ax.set_title("Gain moyen par trade de chaque méthode sur la validation, face au seuil exigé", fontsize=10,
                 color=INK, loc="left")
    fig.tight_layout()
    name = "esperance_validation.png"
    fig.savefig(run.RESULTS / name, dpi=120, facecolor=SURFACE)
    plt.close(fig)
    return name


def build() -> None:
    cfg = etude4.setup()
    sel = json.loads((run.RESULTS / "selection.json").read_text())
    dev = pd.read_csv(run.RESULTS / "summary_dev.csv").set_index("config_id")
    val = pd.read_csv(run.RESULTS / "summary_val.csv").set_index("config_id")
    p_test = run.RESULTS / "summary_test.csv"
    test = pd.read_csv(p_test).set_index("config_id") if p_test.exists() else None
    wf = pd.read_csv(run.RESULTS / "walkforward.csv")
    methods = sel["methods"]
    retained = sel.get("retained", [])
    finalists = sel["finalists"]
    sets = ["dev", "val"] + (["test"] if test is not None else [])
    n_tested = sel["n_variants"] + sel["n_shifted_variants"]
    cr = cfg["etude4"]["criteria"]
    b = {s: cfg["sets"][s] for s in ("dev", "val", "test")}
    end = data.ms_to_ts(data.data_end_ms(cfg) - data.BAR_MS).strftime("%Y-%m-%d")

    if retained:
        verdict = f"**{len(retained)} méthode(s) retenue(s)** : " + ", ".join(f"`{c}`" for c in retained) + "."
    elif test is not None:
        verdict = "**Aucune méthode n'est retenue.** Les finalistes ne remplissent pas tous les critères sur le test final."
    else:
        verdict = ("**Aucune méthode n'est retenue.** Aucune ne remplit tous les critères sur la validation ; "
                   "le test final n'a donc pas été ouvert.")
    L = ["# Rapport : comparaison de sept méthodes sur les perpétuels crypto (15m et 1H)", "",
         "## Verdict", "", verdict, ""]
    L += [f"- Données : 20 paires Binance USDT-M, bougies 15m, funding réel, du {b['dev']['start']} au {end}.",
          f"- Découpe : entraînement {b['dev']['start']} → {b['dev']['end']}, validation {b['val']['start']} → {b['val']['end']}, "
          f"test final {b['test']['start']} → {end}.",
          f"- Variantes testées dans cette étude : **{sel['n_variants']}** (7 méthodes × 8)"
          + (f", plus {sel['n_shifted_variants']} variantes décalées pour le test de stabilité" if sel["n_shifted_variants"] else "")
          + f". Avec les {PREVIOUS_CONFIGS} configurations des études précédentes sur les mêmes données : "
          f"**{n_tested + PREVIOUS_CONFIGS} au total**. Plus on en teste, plus un bon résultat isolé peut être dû au hasard.",
          "- Tous les chiffres sont nets : frais 0,05 % par côté, slippage 0,02 %, funding payé ou reçu. "
          "Risque de 1 % du capital par trade, stop à 1,5 × ATR, 5 positions au plus.", ""]

    # ---- comparison table
    L += ["## Tableau comparatif", "",
          "Une ligne par méthode : la variante gardée est celle qui a la meilleure espérance sur l'entraînement "
          "(parmi celles d'au moins 200 trades). Elle est ensuite mesurée telle quelle sur la validation.", ""]
    rows = []
    for fam, e in methods.items():
        cid = e.get("selected")
        if not cid:
            rows.append([f"**{e['name']}**", "aucune (moins de 200 trades)", "—", "—", "—", "—", "—", "—", "—", "—", "INSUFFISANT"])
            continue
        d, v, c = dev.loc[cid], val.loc[cid], e["validation"]
        if test is not None and cid in test.index:
            t = test.loc[cid]
            tcol = f"{_f(t['expectancy_r'])} R ({int(t['n_trades'])})"
        else:
            tcol = "non ouvert"
        status = "RETENUE" if cid in retained else "REJETÉE"
        rows.append([f"**{e['name']}**", f"`{cid}`", f"{_f(d['expectancy_r'])} R ({int(d['n_trades'])})",
                     f"{_f(v['expectancy_r'])} R ({int(v['n_trades'])})", _f(100 * v["win_rate"], 1, False) + " %",
                     _f(v["profit_factor"], 2, False), _f(v["max_dd_pct"], 1, False) + " %",
                     _f(100 * c["share_pairs_positive"], 0, False) + " %",
                     f"{len(etude4.CRITERIA) - len([x for x in c['criteria_failed'].split(',') if x])} / {len(etude4.CRITERIA)}",
                     tcol, f"**{status}**"])
    L += [_table(["Méthode", "Variante gardée", "Entraînement : E[R] (trades)", "Validation : E[R] (trades)", "Gagnants",
                  "Profit factor", "Drawdown max", "Paires positives", "Critères", "Test final", "Verdict"], rows), "",
          "E[R] = gain moyen par trade en multiples du risque, après tous les coûts. Colonnes « Gagnants » à "
          "« Critères » : sur la validation.", ""]
    name = _bars(cfg, sel, val)
    if name:
        L += [f"![Espérance sur la validation](results_etude4/{name})", ""]

    # ---- reading of the figures (all computed from the result files)
    tf15 = dev.index.str.contains("_tf15m_")
    best_fam = max((f for f in methods if methods[f].get("selected")),
                   key=lambda f: (sum(methods[f]["validation"][k] for k in etude4.CRITERIA),
                                  float(val.loc[methods[f]["selected"], "expectancy_r"])))
    be, bv, bd = methods[best_fam], val.loc[methods[best_fam]["selected"]], dev.loc[methods[best_fam]["selected"]]
    L += ["## Ce que montrent les chiffres", "",
          f"- **En 15m, tout perd.** Les {int(tf15.sum())} variantes en 15m sont négatives sur l'entraînement "
          f"({int((dev[tf15]['expectancy_r'] > 0).sum())} positive) et sur la validation "
          f"({int((val[tf15]['expectancy_r'] > 0).sum())} positive). Une entrée tirée au hasard y perd déjà "
          f"{_f(-dev[tf15]['baseline_median'].median(), 2, False)} R par trade en médiane : c'est le poids des frais quand le stop "
          "est proche du prix.",
          f"- **En 1H, les frais pèsent moitié moins** (hasard : {_f(dev[~tf15]['baseline_median'].median(), 2)} R par trade), "
          f"mais {int((dev[~tf15]['expectancy_r'] > 0).sum())} variantes sur {int((~tf15).sum())} seulement sont positives sur "
          f"l'entraînement et {int((val[~tf15]['expectancy_r'] > 0).sum())} sur la validation.",
          f"- **La méthode la plus proche est « {be['name']} »** (`{be['selected']}`) : {_f(bd['expectancy_r'])} R par trade sur "
          f"l'entraînement, {_f(bv['expectancy_r'])} R sur la validation, profit factor {_f(bv['profit_factor'], 2, False)}, "
          f"drawdown {_f(bv['max_dd_pct'], 1, False)} %. Elle rate : "
          + " ; ".join(LABELS[k] for k in etude4.CRITERIA if not be["validation"][k]) + ". "
          f"En walk-forward elle est positive sur {be['walk_forward']['windows_positive']} fenêtres sur "
          f"{be['walk_forward']['windows']} ({_f(be['walk_forward']['expectancy_r'])} R par trade).",
          "- Aucune méthode n'a le droit d'être appelée rentable ici : les seuils ont été fixés avant le calcul et aucun "
          "n'est franchi en entier.", ""]

    # ---- criteria
    L += ["## Critères sur la validation", ""]
    head = ["Méthode"] + [f"{i + 1}" for i in range(len(etude4.CRITERIA))] + ["Stabilité ±20 %", "Critères ratés"]
    rows = []
    for fam, e in methods.items():
        if not e.get("selected"):
            continue
        c = e["validation"]
        stab = ("✅" if e["stability"]["passed"] else "❌") if "stability" in e else "non calculée"
        failed = " ; ".join(LABELS[k] for k in etude4.CRITERIA if not c[k]) or "aucun"
        rows.append([e["name"]] + [("✅" if c[k] else "❌") for k in etude4.CRITERIA] + [stab, failed])
    L += [_table(head, rows), "",
          "Critères : " + " ; ".join(f"{i + 1}. {LABELS[k]}" for i, k in enumerate(etude4.CRITERIA)) + ".",
          "La stabilité n'est calculée que pour une méthode qui remplit les huit autres critères.", ""]
    rows = []
    for fam, e in methods.items():
        if not e.get("selected"):
            continue
        c, v = e["validation"], val.loc[e["selected"]]
        rows.append([e["name"], _f(100 * c["mc_share_positive"], 1, False) + " %", _f(c["mc_dd_p95_pct"], 1, False) + " %",
                     _f(v["baseline_median"]) + " R", _f(v["baseline_p95"]) + " R", _f(v["baseline_percentile"], 0, False),
                     _f(v["total_return_pct"], 1) + " %", _f(c["return_over_dd"], 2)])
    bh = sel["buy_hold"]["val"]
    L += [_table(["Méthode", "Monte Carlo : tirages positifs", "Drawdown au 95e centile (ordre mélangé)", "Hasard : médiane",
                  "Hasard : 95e centile", "Centile de la méthode", "Rendement", "Rendement / drawdown"], rows), "",
          f"Buy & hold sur la validation (panier égal de {bh['n_pairs']} paires) : rendement {_f(bh['return_pct'], 1)} %, "
          f"drawdown maximal {_f(bh['max_dd_pct'], 1, False)} %, rapport {_f(bh['ratio'], 2)}.", ""]

    # ---- walk-forward
    L += ["## Walk-forward (entraînement + validation)", "",
          "Pour chaque fenêtre de 8 mois, la variante est choisie sur tout ce qui précède, puis mesurée sur la fenêtre.", ""]
    rows = []
    for fam, e in methods.items():
        w = wf[wf["family"] == fam]
        cells = [f"{_f(x['expectancy_r'])} R ({int(x['n_trades'])})" if x["n_trades"] else "—" for _, x in w.iterrows()]
        k = e["walk_forward"]
        rows.append([e["name"]] + cells + [f"{_f(k['expectancy_r'])} R ({k['n_trades']})", f"{k['windows_positive']} / {k['windows']}"])
    wins = [f"{w['start'][:7]} → {w['end'][:7]}" for w in cfg["etude4"]["walk_forward"]]
    L += [_table(["Méthode"] + wins + ["Ensemble", "Fenêtres positives"], rows), ""]

    name = _curves(cfg, sel, sets)
    if name:
        L += ["## Courbes de capital", "", f"![Courbes par méthode](results_etude4/{name})", "",
              "Chaque panneau a sa propre échelle verticale. La ligne pointillée marque le début de la validation"
              + (" puis du test final." if test is not None else "."), ""]

    # ---- final test
    L += ["## Test final", ""]
    if test is None:
        L += ["Non ouvert : aucune méthode ne remplit tous les critères sur la validation. "
              f"Les données du {b['test']['start']} au {end} n'ont pas été lues dans cette étude.", ""]
    else:
        rows = []
        for cid in finalists:
            fam = next(f for f, e in methods.items() if e.get("selected") == cid)
            c, t, v = methods[fam]["test"], test.loc[cid], val.loc[cid]
            rows.append([f"`{cid}`", f"{_f(v['expectancy_r'])} R ({int(v['n_trades'])})", f"{_f(t['expectancy_r'])} R ({int(t['n_trades'])})",
                         _f(t["profit_factor"], 2, False), _f(t["max_dd_pct"], 1, False) + " %",
                         " ; ".join(LABELS[k] for k in etude4.CRITERIA if not c[k]) or "aucun",
                         "**RETENUE**" if cid in retained else "**REJETÉE**"])
        L += [_table(["Variante", "Validation : E[R] (trades)", "Test : E[R] (trades)", "Profit factor", "Drawdown max",
                      "Critères ratés sur le test", "Verdict"], rows), ""]

    # ---- full grid
    L += ["## Toutes les variantes", ""]
    rows = []
    for cid in dev.index:
        d, v = dev.loc[cid], val.loc[cid]
        rows.append([f"`{cid}`", int(d["n_trades"]), _f(d["expectancy_r"]), _f(d["profit_factor"], 2, False), int(v["n_trades"]),
                     _f(100 * v["win_rate"], 1, False), _f(v["expectancy_r"]), _f(v["profit_factor"], 2, False),
                     _f(v["max_dd_pct"], 1, False)])
    L += [_table(["Variante", "Entr. : trades", "Entr. : E[R]", "Entr. : PF", "Valid. : trades", "Valid. : % gagnants",
                  "Valid. : E[R]", "Valid. : PF", "Valid. : DD %"], rows,
                 ["---"] + ["---:"] * 8), "",
          f"Variantes à espérance positive sur l'entraînement : {int((dev['expectancy_r'] > 0).sum())} sur {len(dev)} ; "
          f"sur la validation : {int((val['expectancy_r'] > 0).sum())} sur {len(val)}.", ""]

    L += ["## Limites", "",
          f"- **Données déjà utilisées.** {PREVIOUS_CONFIGS} configurations avaient été testées sur ces paires et ces années avant "
          "cette étude. La découpe entraînement / validation n'est donc pas neuve.",
          "- **Test final.** La période 2025-2026 a été ouverte une fois, pour une configuration 4h, dans une étude précédente.",
          "- **Biais de survie.** Les 20 paires sont les plus échangées fin 2026 ; les contrats disparus ne sont pas testés.",
          "- **Exécution simulée.** Résolution 15 minutes, slippage fixe, pas de carnet d'ordres ni d'impact de marché. "
          "Stop prioritaire sur l'objectif dans la même bougie.",
          "- **Règles mécaniques.** Chaque méthode est une traduction codée parmi d'autres possibles. Un rejet ne prouve pas "
          "qu'une lecture discrétionnaire de la même idée échoue ; il prouve que ces règles-là échouent.",
          "- **Baseline aléatoire** : tirée d'un réservoir d'entrées au hasard, sans la limite de 5 positions simultanées.",
          "- Aucune performance future n'est promise par ce document.", "",
          "## Fichiers", "",
          "`PROTOCOLE_ETUDE_4.md` (règles écrites avant le calcul), `config/etude4.yaml` (grille et seuils), "
          "`results_etude4/` (trades, tableaux, graphiques), `TRIALS_etude4.csv` (toutes les évaluations).", "",
          "```bash", "python -m src.etude4 run && python -m src.etude4 report", "```", ""]
    checks = run.RESULTS / "controles.md"
    if checks.exists():
        L += ["## Contrôles", "", checks.read_text(encoding="utf-8").rstrip(), ""]
    (data.ROOT / "rapport.md").write_text("\n".join(L), encoding="utf-8")
    run.log("report written: rapport.md")
