"""Study 7 report: RAPPORT_ETUDE_7.md, charts, and the liquidation-adjusted carry (built from the result files and data)."""
from __future__ import annotations

import json

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from . import data as D, etude7  # noqa: E402

INK, INK2, MUTED, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7", "#fcfcfb"
SERIES = {"CARRY": "#2a78d6", "TSMOM": "#eb6834", "XSMOM": "#1baf7a", "buy_hold": "#898781"}
LIQ_PENALTY = 0.015       # liquidation fee + slippage + re-entry, as a share of the liquidated leg's notional
NAMES = {"CARRY": "Carry (spot acheté, perpétuel vendu)", "TSMOM": "Suivi de tendance journalier",
         "XSMOM": "Momentum relatif entre cryptos", "buy_hold": "Buy & hold (panier égal)"}


def _f(x, n=2, sign=False):
    if x is None or not np.isfinite(x):
        return "—"
    return (f"{x:+.{n}f}" if sign else f"{x:.{n}f}").replace(".", ",")


def liquidations(syms, margin_share, cfg, close, spot, fund):
    """Days on which the intraday high rose enough above the previous close to liquidate the short leg."""
    avail = etude7.available(close, cfg["warmup_days"])
    act = etude7.carry_active(spot, fund, avail, {"window_days": 14, "min_annual_funding": 0.0})
    held = act.shift(1, fill_value=False)
    cd = D.load_config()
    cd["final_test_unlocked"] = True
    out = pd.DataFrame(False, index=close.index, columns=syms)
    for s in syms:
        try:
            k = D.load_klines(cd, s)
        except Exception:
            return None
        hi = pd.Series(k["high"].values, index=pd.to_datetime(k["open_time"], unit="ms", utc=True))
        dmax = hi.groupby(hi.index.floor("D")).max().reindex(close.index)
        out[s] = held[s] & (dmax / close[s].shift(1) - 1 >= margin_share - 0.01)
    return out


def adjusted_carry(syms, margin_share, cfg, close_all, spot_all, fund_all, liq):
    close, spot, fund = close_all[syms], spot_all.reindex(columns=syms), fund_all[syms]
    c2 = dict(cfg)
    c2["families"] = {**cfg["families"], "CARRY": {"fixed": {"perp_margin_share": margin_share}}}
    avail = etude7.available(close, cfg["warmup_days"])
    ret, held, _ = etude7.simulate({"family": "CARRY", "params": {"window_days": 14, "min_annual_funding": 0.0}},
                                   close, spot, fund, avail, c2)
    if liq is not None:
        ret = ret - (liq.astype(float) * held).sum(axis=1) * LIQ_PENALTY
    return ret


def yearly(ret):
    s = ret.loc["2020":]
    return ((1 + s).groupby(s.index.year).prod() - 1) * 100


def chart(curves, path, title):
    fig, ax = plt.subplots(figsize=(10, 4.2), facecolor=SURFACE)
    ax.set_facecolor(SURFACE)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.tick_params(colors=MUTED, labelsize=8, length=0)
    ax.grid(axis="y", color=GRID, linewidth=0.6)
    for key, s in curves.items():
        eq = (1 + s.fillna(0)).cumprod() * 100
        ax.plot(eq.index, eq.values, color=SERIES[key], linewidth=1.8 if key != "buy_hold" else 1.2)
        ax.annotate(NAMES[key].split(" (")[0], (eq.index[-1], eq.values[-1]), xytext=(4, 0), textcoords="offset points",
                    fontsize=8, color=INK, va="center")
    ax.set_yscale("log")
    ax.set_ylabel("Capital (base 100, échelle log)", fontsize=8.5, color=INK2)
    ax.set_title(title, fontsize=10, color=INK, loc="left")
    ax.margins(x=0.12)
    fig.tight_layout()
    fig.savefig(path, dpi=120, facecolor=SURFACE)
    plt.close(fig)


def build():
    cfg = etude7.load_cfg()
    R = etude7.RESULTS
    sel = json.loads((R / "selection.json").read_text())
    df = pd.read_csv(R / "summary.csv")
    rets = pd.read_parquet(R / "daily_returns.parquet")
    close_all, spot_all, fund_all = etude7.load_market()
    u = etude7.universe()

    liq = {m: liquidations(u["in_sample"], m, cfg, close_all[u["in_sample"]], spot_all.reindex(columns=u["in_sample"]),
                           fund_all[u["in_sample"]]) for m in (0.25, 0.5)}
    adj = {m: adjusted_carry(u["in_sample"], m, cfg, close_all, spot_all, fund_all, liq[m]) for m in (0.25, 0.5)}
    base = adjusted_carry(u["in_sample"], 0.25, cfg, close_all, spot_all, fund_all, None)
    new_base = adjusted_carry(u["new"], 0.25, cfg, close_all, spot_all, fund_all, None)

    chosen = {f: e["chosen"] for f, e in sel["families"].items()}
    for setname, title, fn in (("in_sample", "Paires d'origine, 2020-2023 (choix de la variante)", "courbes_in_sample.png"),
                               ("oos_time", "Paires d'origine, 2024 → 2026-10 (hors échantillon)", "courbes_oos_temps.png"),
                               ("oos_assets", "20 paires jamais utilisées, 2020 → 2026-10 (hors échantillon)", "courbes_oos_paires.png")):
        curves = {f: rets[(setname, v)].dropna() for f, v in chosen.items()}
        curves["buy_hold"] = rets[(setname, "buy_hold")].dropna()
        chart(curves, R / fn, title)

    crit_names = {"c1": "Sharpe ≥ 1", "c2": "IC du Sharpe > 0", "c3": "drawdown < 25 %", "c4": "positif avec coûts ×2",
                  "c5": "≥ 60 % des trimestres positifs", "c6": "positif dans 2 régimes sur 3", "c7": "mieux que le buy & hold"}
    L = ["# Étude 7 : stratégies journalières issues de la recherche — résultats", "",
         "Protocole : `PROTOCOLE_ETUDE_7.md` (écrit avant le calcul et avant le téléchargement des nouvelles paires). "
         "Code : `src/etude7*.py`. Résultats : `results_etude7/`.", "",
         "## Verdict", "",
         "**Une seule famille remplit tous les critères fixés à l'avance : le carry** (acheter le spot et vendre le perpétuel "
         "de la même crypto tant que le funding moyen des 14 derniers jours est positif). C'est la seule stratégie de toutes nos "
         "études qui montre un avantage statistique net sur des données hors échantillon, y compris sur 20 paires jamais utilisées.",
         "",
         "**Mais je ne recommande pas de la mettre en place maintenant** : son rendement s'est effondré en 2025-2026 "
         "(de l'ordre de 0 à 1,5 % par an), en dessous de ce que rapporte un placement en stablecoin presque sans risque, et une "
         "partie du risque (liquidation de la jambe vendue, faillite de plateforme) n'apparaît pas dans un backtest journalier. "
         "Le suivi de tendance journalier et le momentum relatif échouent hors échantillon.", "",
         "## Tableau comparatif (variante gardée dans chaque famille, choisie sur 2020-2023)", "",
         "| Stratégie | Variante | 2020-2023 : Sharpe / rendement annuel / drawdown | 2024-2026 (mêmes paires) | "
         "20 nouvelles paires 2020-2026 | Critères ratés | Verdict |", "|---|---|---|---|---|---|---|"]
    for f, e in sel["families"].items():
        cells = []
        for s in ("in_sample", "oos_time", "oos_assets"):
            r = df[(df["set"] == s) & (df["variant"] == e["chosen"])].iloc[0]
            cells.append(f"{_f(r['sharpe'])} / {_f(r['cagr_pct'], 1, True)} % / {_f(r['max_dd_pct'], 1)} %")
        failed = sorted(set(e["oos_time"]["criteria"]["failed"].split(",") + e["oos_assets"]["criteria"]["failed"].split(",")) - {""})
        L.append(f"| **{NAMES[f]}** | `{e['chosen']}` | " + " | ".join(cells) + " | "
                 + (" ; ".join(crit_names[c] for c in failed) or "aucun") + f" | **{'RETENUE' if e['retained'] else 'REJETÉE'}** |")
    bh = sel["buy_hold"]
    L += ["", f"Buy & hold du panier égal : Sharpe {_f(bh['in_sample']['sharpe'])} (2020-2023), {_f(bh['oos_time']['sharpe'])} "
          f"(2024-2026), {_f(bh['oos_assets']['sharpe'])} (nouvelles paires) ; drawdowns de {_f(bh['in_sample']['max_dd_pct'], 0)} %, "
          f"{_f(bh['oos_time']['max_dd_pct'], 0)} % et {_f(bh['oos_assets']['max_dd_pct'], 0)} %.", "",
          "Rendements nets de frais (perpétuel 0,05 %, spot 0,10 % par côté), de slippage (0,02 %) et du funding réel. "
          "Sharpe calculé sans retrancher le taux sans risque.", "",
          "![2020-2023](results_etude7/courbes_in_sample.png)", "", "![2024-2026](results_etude7/courbes_oos_temps.png)", "",
          "![Nouvelles paires](results_etude7/courbes_oos_paires.png)", "",
          "## Toutes les variantes", "", "| Variante | 2020-2023 : Sharpe | 2024-2026 : Sharpe | Nouvelles paires : Sharpe | "
          "2020-2023 : drawdown | 2024-2026 : drawdown | Nouvelles paires : drawdown |", "|---|---:|---:|---:|---:|---:|---:|"]
    main = df[~df["shifted"]]
    for v in main["variant"].unique():
        g = main[main["variant"] == v].set_index("set")
        L.append(f"| `{v}` | " + " | ".join(_f(g.loc[s, "sharpe"]) for s in ("in_sample", "oos_time", "oos_assets")) + " | "
                 + " | ".join(_f(g.loc[s, "max_dd_pct"], 1) + " %" for s in ("in_sample", "oos_time", "oos_assets")) + " |")
    car = sel["families"]["CARRY"]
    L += ["", f"Stabilité (fenêtre de funding décalée de ±20 %, Sharpe 2020-2023) : "
          + " ; ".join(f"`{k}` {_f(v)}" for k, v in car["stability"].items()) + ".", ""]

    # regimes
    L += ["## Par régime de marché (somme des rendements journaliers, %)", "",
          "Régime défini chaque jour par le rendement du BTC sur 90 jours : hausse au-delà de +20 %, baisse sous −20 %, "
          "range entre les deux.", "", "| Stratégie | Jeu | Hausse | Baisse | Range |", "|---|---|---:|---:|---:|"]
    for f, e in sel["families"].items():
        for s, lab in (("oos_time", "2024-2026"), ("oos_assets", "nouvelles paires")):
            m = e[s]["metrics"]
            L.append(f"| {NAMES[f]} | {lab} | " + " | ".join(_f(m.get(f"regime_{k}_sum_pct", np.nan), 1, True)
                                                           for k in ("hausse", "baisse", "range")) + " |")

    # carry details
    yo, yn = yearly(base), yearly(new_base)
    L += ["", "## Le carry en détail", "", "### Rendement par année (levier 4 sur la jambe vendue, sans coût de liquidation)", "",
          "| Année | Paires d'origine | Nouvelles paires |", "|---|---:|---:|"]
    for y in yo.index:
        L.append(f"| {y} | {_f(yo.get(y), 1, True)} % | {_f(yn.get(y), 1, True)} % |")
    L += ["", "Le rendement vient presque entièrement du funding encaissé ; l'écart entre spot et perpétuel (basis) pèse peu. "
          "Le funding moyen a fortement baissé depuis 2025, comme le décrit la littérature (plus de capital d'arbitrage, "
          "écarts qui se réduisent). Pour comparaison, un placement en stablecoin rapportait de l'ordre de 4 % par an en "
          "2024-2025 (ordre de grandeur, non vérifié dans ce projet).", "",
          "### Risque de liquidation de la jambe vendue (paires d'origine, bougies 15m)", ""]
    n25, n50 = int(liq[0.25].sum().sum()), int(liq[0.5].sum().sum())
    ya25, ya50 = yearly(adj[0.25]), yearly(adj[0.5])
    L += [f"Avec des comptes de marge séparés et la marge remise à niveau chaque jour à la clôture, une hausse intraday "
          f"suffisante pour liquider le perpétuel vendu se produit **{n25} fois** avec un levier 4 et **{n50} fois** avec un "
          f"levier 2. Chaque liquidation coûte ici {_f(100 * LIQ_PENALTY, 1)} % du notionnel de la paire (frais de liquidation, "
          "slippage, remise en place), estimation prudente.", "",
          "| Année | Levier 4, avec liquidations | Levier 2, avec liquidations |", "|---|---:|---:|"]
    for y in ya25.index:
        L.append(f"| {y} | {_f(ya25.get(y), 1, True)} % | {_f(ya50.get(y), 1, True)} % |")
    def stats(r, a, b):
        s = r.loc[a:b]
        eq = (1 + s).cumprod()
        return (s.mean() / s.std() * np.sqrt(365), 100 * (eq.iloc[-1] ** (365 / len(s)) - 1), 100 * float((1 - eq / eq.cummax()).max()))
    L += ["", "| Version | 2020-2023 : Sharpe / rendement annuel / drawdown | 2024-2026 |", "|---|---|---|"]
    for lab, r in (("Levier 4, sans liquidations (backtest du protocole)", base), ("Levier 4, avec liquidations", adj[0.25]),
                   ("Levier 2, avec liquidations", adj[0.5])):
        a, b = stats(r, "2020-01-01", "2023-12-31"), stats(r, "2024-01-01", "2026-10-31")
        L.append(f"| {lab} | {_f(a[0])} / {_f(a[1], 1, True)} % / {_f(a[2], 1)} % | {_f(b[0])} / {_f(b[1], 1, True)} % / {_f(b[2], 1)} % |")
    L += ["", "Un compte à marge unifiée (le spot sert de garantie au perpétuel, proposé par Binance et OKX) réduit fortement ce "
          "risque, sans le supprimer (décotes sur la garantie, auto-deleveraging).", "",
          "## Faiblesses et risques", "",
          "- **Rendement qui disparaît** : 0 à 1,5 % par an en 2025-2026, en dessous d'un placement sans risque.",
          "- **Risque de plateforme** : tout le capital est sur l'exchange (exemple de FTX en 2022). Aucun backtest ne le mesure.",
          "- **Liquidation et auto-deleveraging** de la jambe vendue lors des hausses violentes.",
          "- **Taille minimale** : un notionnel minimum par ordre (souvent 5 à 100 USDT selon la paire et la plateforme) ; avec "
          "environ 1 900 USDT, seules quelques paires sont praticables, ce qui augmente le risque par paire.",
          "- **Plateforme différente** : les calculs utilisent le funding de Binance ; celui d'OKX est proche mais pas identique.",
          "- **Backtest journalier** : clôtures de 00:00 UTC, pas de carnet d'ordres, écart d'exécution entre les deux jambes ignoré.",
          "- **Trous de données** de 5 jours en 2022 sur 11 paires, non comblés.", "",
          "## Ce que ces résultats ne prouvent pas", "",
          "- Ils ne prouvent pas que le carry redeviendra rentable ; il l'a été surtout en marché haussier (2021 : environ +29 %).",
          "- Le suivi de tendance et le momentum relatif rejetés ici restent étudiés sur d'autres marchés ; ils n'ont simplement "
          "pas passé ces critères sur ces cryptos.", "",
          "## Contrôles", "",
          f"- Variantes : {sel['n_variants']} dans cette étude (+ {sel['n_shifted']} décalées pour la stabilité) ; environ 220 au "
          "total sur ces marchés avec les études 1 à 6.",
          "- Tests : décisions identiques sur un historique tronqué (aucun regard vers le futur), calendrier des rééquilibrages, "
          "calcul du funding, des coûts et du résultat du carry vérifiés à la main (`tests/test_study7.py`).",
          "- Données téléchargées depuis data.binance.vision avec vérification des sommes SHA-256.", ""]
    (D.ROOT / "RAPPORT_ETUDE_7.md").write_text("\n".join(L), encoding="utf-8")
    print("RAPPORT_ETUDE_7.md written")
    return {"liq": (n25, n50), "y25": ya25.round(1).to_dict(), "y50": ya50.round(1).to_dict()}


if __name__ == "__main__":
    print(build())
