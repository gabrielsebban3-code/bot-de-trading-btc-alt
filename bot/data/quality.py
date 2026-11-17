"""Data quality report (Phase 1 deliverable): bot/reports/data_quality.md."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from ..core.config import resolve_path
from ..core.timeutil import DAY_MS, month_end_ms, ms_to_str, tf_ms, to_ms
from .resampler import find_gaps, resample
from .storage import MarketStore, readable_end_ms


def symbol_quality(store: MarketStore, symbol: str, tf: str, last_month_end: int, big_move: float = 0.30) -> dict:
    df = store.candles(symbol, tf)
    if df.empty:
        return {"symbol": symbol, "tf": tf, "rows": 0}
    ot = df["open_time"].to_numpy()
    step = tf_ms(tf)
    end = min(last_month_end, readable_end_ms(store.cfg))
    expected = int((min(end, ot[-1] + step) - ot[0]) // step)
    gaps = find_gaps(ot, tf)
    o, h, l, c = (df[k].to_numpy() for k in ("open", "high", "low", "close"))
    move = np.maximum(np.abs(c / o - 1), h / l - 1)
    big = np.nonzero(move > big_move)[0]
    return {
        "symbol": symbol, "tf": tf, "rows": int(len(df)), "first": ms_to_str(ot[0]), "last": ms_to_str(ot[-1]),
        "expected": expected, "missing": int(sum(g[2] for g in gaps)),
        "missing_pct": round(100 * sum(g[2] for g in gaps) / expected, 4) if expected else 0.0,
        "n_gaps": len(gaps),
        "largest_gap": max((g[2] for g in gaps), default=0),
        "gaps_preview": [(ms_to_str(a), ms_to_str(b), n) for a, b, n in sorted(gaps, key=lambda g: -g[2])[:3]],
        "bad_ohlc": int(((h < l) | (c > h) | (c < l) | (o > h) | (o < l)).sum()),
        "zero_volume": int((df["volume"].to_numpy() == 0).sum()),
        "big_moves": [(ms_to_str(ot[i]), round(float(move[i]) * 100, 1)) for i in big[:5]],
        "n_big_moves": int(len(big)),
    }


def native_check(store: MarketStore, symbol: str, tf: str) -> dict:
    """Compare candles resampled from 15m with Binance's native archive candles of the same months."""
    nat = store.candles(symbol, tf)
    if nat.empty:
        return {"symbol": symbol, "tf": tf, "compared": 0}
    lo, hi = int(nat["open_time"].min()), int(nat["open_time"].max()) + tf_ms(tf)
    res = resample(store.candles(symbol, "15m", lo, hi), "15m", tf)
    j = nat.merge(res, on="open_time", suffixes=("_n", "_r"))
    out = {"symbol": symbol, "tf": tf, "native": int(len(nat)), "compared": int(len(j))}
    for k in ("open", "high", "low", "close", "volume"):
        rel = np.abs(j[f"{k}_n"] - j[f"{k}_r"]) / np.maximum(np.abs(j[f"{k}_n"]), 1e-12)
        out[f"max_rel_diff_{k}"] = float(rel.max()) if len(rel) else float("nan")
    return out


def _table(rows: list[dict], cols: list[str]) -> str:
    head = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    return head + "\n".join("| " + " | ".join(str(r.get(c, "")) for c in cols) + " |" for r in rows) + "\n"


def write_quality_report(cfg: dict, store: MarketStore) -> Path:
    last_end = month_end_ms(cfg["data"]["last_month"])
    lines = ["# Qualité des données\n",
             f"Généré à partir de `{resolve_path(cfg, 'market_db').name}`. Période lisible : "
             f"{cfg['data']['history_start']} → {ms_to_str(min(last_end, readable_end_ms(cfg)) - 1, '%Y-%m-%d')} "
             f"(verrou du test final : {cfg['final_test']['start']}, aucune donnée postérieure n'est stockée).\n"]
    # catalogue & universe
    cat_all = store.catalog(eligible_only=False)
    cat = store.catalog()
    u = store.universe()
    hold = store.holdout()
    # delisted = no traded volume during the last month of data (Binance keeps zero-volume candles after a delisting)
    last_traded = {}
    for sym in set(u["symbol"]) if not u.empty else []:
        d = store.candles(sym, "1d")
        vol = d[d["volume"] > 0]
        last_traded[sym] = int(vol["open_time"].max()) if len(vol) else 0
    cutoff = month_end_ms(cfg["data"]["last_month"]) - 31 * DAY_MS
    delisted = {s for s, t in last_traded.items() if t < cutoff}
    lines.append("## Catalogue et univers\n")
    lines.append(f"- Symboles présents dans les archives USDT-M : {len(cat_all)} ; éligibles : {len(cat)} "
                 f"(exclus : {cat_all['reason'].value_counts().to_dict()}).")
    if not u.empty:
        um = u.merge(hold[["symbol", "holdout"]], on="symbol", how="left")
        per_month = um.groupby("month").agg(n=("symbol", "size"), held=("holdout", "sum"))
        ever = sorted(set(u["symbol"]))
        lines.append(f"- Univers mensuel (top {cfg['universe']['top_n']}, volume moyen ≥ "
                     f"{cfg['universe']['min_avg_daily_quote_volume'] / 1e6:.0f} M USDT/jour sur "
                     f"{cfg['universe']['volume_window_days']} jours clos) : {u['month'].nunique()} mois, "
                     f"{len(ever)} symboles distincts dont {len(set(ever) & delisted)} délistés depuis.")
        lines.append(f"- Membres par mois : min {per_month['n'].min()}, max {per_month['n'].max()} ; "
                     f"dont mis de côté (jamais lus avant le test final) : en moyenne {per_month['held'].mean():.1f} par mois.")
        lines.append(f"- Paires de l'univers qui ne s'échangent plus (aucun volume pendant le dernier mois : délistées ou renommées) : "
                     f"{len(set(ever) & delisted)} : {', '.join(sorted(set(ever) & delisted)) or 'aucune'}. "
                     f"Elles sont incluses tant qu'elles étaient dans le top 30 (pas de biais de survivance).")
        early = per_month[per_month["n"] < int(cfg["universe"]["top_n"])]
        if len(early):
            lines.append(f"- Mois avec moins de {cfg['universe']['top_n']} membres (volume minimum non atteint) : "
                         f"{', '.join(f'{m} ({int(r.n)})' for m, r in early.iterrows())}.\n")
    # 15m quality
    syms = store.symbols_with(cfg["data"]["long_tf"])
    q = [symbol_quality(store, s, cfg["data"]["long_tf"], last_end) for s in syms]
    q = [r for r in q if r["rows"]]
    if q:
        miss = np.array([r["missing_pct"] for r in q])
        lines.append(f"## Bougies {cfg['data']['long_tf']} ({len(q)} symboles)\n")
        lines.append(f"- Bougies manquantes : médiane {np.median(miss):.3f} %, max {miss.max():.3f} %. "
                     f"Les trous ne sont jamais comblés : un trade qui en rencontre un est annulé, et aucun signal "
                     f"n'est émis pendant {cfg['engine']['warmup_days']} jours après.")
        lines.append(f"- OHLC incohérents : {sum(r['bad_ohlc'] for r in q)} ; volume nul : "
                     f"{sum(r['zero_volume'] for r in q)} bougies ; mouvements > 30 % sur une bougie : "
                     f"{sum(r['n_big_moves'] for r in q)} (listés, non supprimés).\n")
        worst = sorted(q, key=lambda r: -r["missing_pct"])[:15]
        lines.append("Symboles avec le plus de bougies manquantes :\n")
        lines.append(_table(worst, ["symbol", "first", "last", "rows", "missing", "missing_pct", "n_gaps", "largest_gap",
                                    "gaps_preview"]))
    # fine tf
    fine_files = store.files(f"klines_{cfg['data']['fine_tf']}")
    fine_files = fine_files[fine_files["status"] == "ok"]
    if len(fine_files):
        step = tf_ms(cfg["data"]["fine_tf"])
        expected = sum((month_end_ms(p) - month_end_ms(str(pd.Period(p, freq="M") - 1))) // step for p in fine_files["period"])
        got = int(fine_files["rows"].sum())
        lines.append(f"\n## Bougies {cfg['data']['fine_tf']} ({fine_files['symbol'].nunique()} symboles, mois où ils étaient "
                     f"membres de l'univers sur les {cfg['data']['fine_months']} derniers mois)\n")
        lines.append(f"- {len(fine_files)} fichiers mensuels, {got} bougies sur {expected} attendues "
                     f"({100 * (1 - got / expected):.3f} % manquantes).\n")
    # resampler check
    checks = []
    for s in ("BTCUSDT", "ETHUSDT", "DOGEUSDT"):
        for tf in ("1h", "4h"):
            checks.append(native_check(store, s, tf))
        d = store.candles(s, "1d")
        if not d.empty:
            checks.append(native_check(store, s, "1d"))
    checks = [c for c in checks if c.get("compared")]
    if checks:
        lines.append("## Contrôle du rééchantillonnage (15m → 1h / 4h / 1d) contre les archives natives Binance\n")
        lines.append(_table([{k: (f"{v:.2e}" if isinstance(v, float) else v) for k, v in c.items()} for c in checks],
                            ["symbol", "tf", "native", "compared", "max_rel_diff_open", "max_rel_diff_high",
                             "max_rel_diff_low", "max_rel_diff_close", "max_rel_diff_volume"]))
    # funding
    fr = []
    for s in syms:
        f = store.funding(s)
        if len(f):
            dt = np.diff(f["time"].to_numpy()) / 3_600_000
            fr.append({"symbol": s, "rows": len(f), "first": ms_to_str(f["time"].iloc[0]),
                       "max_interval_h": round(float(dt.max()), 1) if len(dt) else 0})
    if fr:
        lines.append(f"\n## Funding\n\n- {len(fr)} symboles, {sum(r['rows'] for r in fr)} règlements. "
                     f"Intervalle maximal entre deux règlements > 8 h pour {sum(r['max_interval_h'] > 8.5 for r in fr)} "
                     f"symboles (archives incomplètes ou changement d'intervalle).\n")
    # OI depth
    oi_path = resolve_path(cfg, "reports") / "oi_depth.json"
    if oi_path.exists():
        oi = pd.DataFrame(json.loads(oi_path.read_text()))
        ok = oi[oi["n_days"] > 0]
        lines.append("## Open interest (fichiers `metrics`, pas de 5 minutes)\n")
        lines.append(f"- {len(ok)} symboles sur {len(oi)} ont un historique. Premier jour : le plus ancien "
                     f"{ok['first_day'].min()}, médiane {ok['first_day'].sort_values().iloc[len(ok) // 2]}.")
        lines.append(f"- BTCUSDT : {oi.loc[oi['symbol'] == 'BTCUSDT', 'first_day'].tolist()} ; "
                     f"ETHUSDT : {oi.loc[oi['symbol'] == 'ETHUSDT', 'first_day'].tolist()}.")
        lines.append("- Liquidations : aucune archive publique (`liquidationSnapshot` vide pour les USDT-M). "
                     "Aucune donnée de liquidation n'est utilisée en backtest.\n")
    path = resolve_path(cfg, "reports") / "data_quality.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
