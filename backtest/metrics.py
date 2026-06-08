"""
Calcul des métriques de performance sur la liste des trades backtestés.
Produit aussi la courbe d'equity et les fichiers de sortie.
"""
from __future__ import annotations

import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from backtest.engine import Trade

RESULTS_DIR = Path(__file__).parent / "results"


# ─── Statistiques ─────────────────────────────────────────────────────────────

def compute_metrics(trades: list[Trade]) -> dict:
    """Calcule toutes les métriques sur la liste des trades."""
    if not trades:
        return {"nb_trades": 0}

    pnl_r = [t.pnl_r for t in trades]
    pnl_pct = [t.pnl_pct for t in trades]
    wins = [r for r in pnl_r if r > 0]
    losses = [r for r in pnl_r if r <= 0]

    win_rate = len(wins) / len(trades) * 100
    avg_win = np.mean(wins) if wins else 0.0
    avg_loss = abs(np.mean(losses)) if losses else 0.0

    profit_factor = (sum(wins) / abs(sum(losses))) if losses else float("inf")
    expectancy = np.mean(pnl_r)

    # Courbe d'equity en % (départ à 100)
    equity = np.cumsum([0] + pnl_pct) + 100
    max_equity = np.maximum.accumulate(equity)
    drawdowns = (equity - max_equity) / max_equity * 100
    max_drawdown = float(np.min(drawdowns))

    total_return = float(equity[-1] - 100)

    # Sharpe annualisé (simplifié, basé sur les R journaliers)
    df = pd.DataFrame({"pnl_r": pnl_r, "entry_time": [t.entry_time for t in trades]})
    df["date"] = pd.to_datetime(df["entry_time"]).dt.date
    daily = df.groupby("date")["pnl_r"].sum()
    sharpe = float(daily.mean() / daily.std() * np.sqrt(252)) if daily.std() > 0 else 0.0

    exit_reasons = {}
    for t in trades:
        exit_reasons[t.exit_reason] = exit_reasons.get(t.exit_reason, 0) + 1

    return {
        "nb_trades": len(trades),
        "win_rate_pct": round(win_rate, 1),
        "avg_win_r": round(avg_win, 2),
        "avg_loss_r": round(avg_loss, 2),
        "profit_factor": round(profit_factor, 2),
        "expectancy_r": round(expectancy, 2),
        "max_drawdown_pct": round(max_drawdown, 2),
        "total_return_pct": round(total_return, 2),
        "sharpe_annualized": round(sharpe, 2),
        "exit_reasons": exit_reasons,
    }


# ─── Export CSV des trades ────────────────────────────────────────────────────

def save_trades_csv(trades: list[Trade], filename: str = "trades.csv") -> Path:
    """Sauvegarde tous les trades dans un CSV détaillé."""
    RESULTS_DIR.mkdir(exist_ok=True)
    path = RESULTS_DIR / filename

    fields = [
        "symbol", "side", "entry_time", "exit_time", "entry_price",
        "exit_price", "sl", "tp1", "tp2", "rr", "score",
        "exit_reason", "pnl_r", "pnl_pct", "fees_pct",
    ]

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for t in trades:
            writer.writerow({
                "symbol": t.symbol,
                "side": t.side,
                "entry_time": t.entry_time,
                "exit_time": t.exit_time,
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "sl": t.sl,
                "tp1": t.tp1,
                "tp2": t.tp2,
                "rr": t.rr,
                "score": t.score,
                "exit_reason": t.exit_reason,
                "pnl_r": round(t.pnl_r, 4),
                "pnl_pct": round(t.pnl_pct, 4),
                "fees_pct": round(t.fees_pct, 4),
            })

    return path


# ─── Summary texte ────────────────────────────────────────────────────────────

def save_summary(
    metrics: dict,
    symbols: list[str],
    period_start: datetime,
    period_end: datetime,
    filename: str = "summary.txt",
) -> Path:
    """Écrit un résumé lisible des performances."""
    RESULTS_DIR.mkdir(exist_ok=True)
    path = RESULTS_DIR / filename

    lines = [
        "=" * 60,
        "  BACKTEST SUMMARY — Trend-Pullback Scalper",
        "=" * 60,
        f"  Paires     : {', '.join(symbols)}",
        f"  Période    : {period_start.date()} → {period_end.date()}",
        "",
        f"  Nb trades       : {metrics.get('nb_trades', 0)}",
        f"  Win rate        : {metrics.get('win_rate_pct', 0):.1f}%",
        f"  Avg win (R)     : {metrics.get('avg_win_r', 0):.2f}R",
        f"  Avg loss (R)    : {metrics.get('avg_loss_r', 0):.2f}R",
        f"  Profit factor   : {metrics.get('profit_factor', 0):.2f}",
        f"  Expectancy      : {metrics.get('expectancy_r', 0):.2f}R",
        f"  Max drawdown    : {metrics.get('max_drawdown_pct', 0):.2f}%",
        f"  Return total    : {metrics.get('total_return_pct', 0):.2f}%",
        f"  Sharpe annuel   : {metrics.get('sharpe_annualized', 0):.2f}",
        "",
        "  Raisons de sortie :",
    ]
    for reason, count in metrics.get("exit_reasons", {}).items():
        lines.append(f"    {reason:<6} : {count}")

    lines += ["", "=" * 60]

    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")

    return path


# ─── Courbe d'equity ──────────────────────────────────────────────────────────

def plot_equity_curve(
    trades: list[Trade],
    metrics: dict,
    filename: str = "equity_curve.png",
) -> Optional[Path]:
    """Génère et sauvegarde la courbe d'equity en PNG."""
    try:
        import matplotlib
        matplotlib.use("Agg")  # backend non-interactif pour Railway/CI
        import matplotlib.pyplot as plt
        import matplotlib.dates as mdates
    except ImportError:
        return None

    if not trades:
        return None

    RESULTS_DIR.mkdir(exist_ok=True)
    path = RESULTS_DIR / filename

    pnl_pct = [0.0] + [t.pnl_pct for t in trades]
    equity = np.cumsum(pnl_pct) + 100
    times = [trades[0].entry_time] + [t.exit_time or t.entry_time for t in trades]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), gridspec_kw={"height_ratios": [3, 1]})
    fig.suptitle("Equity Curve — Trend-Pullback Scalper Backtest", fontsize=14, fontweight="bold")

    # Courbe d'equity
    ax1.plot(times, equity, color="#2196F3", linewidth=1.5, label="Equity")
    ax1.axhline(100, color="gray", linestyle="--", linewidth=0.8, alpha=0.6)

    # Zone de drawdown (rouge)
    max_eq = np.maximum.accumulate(equity)
    ax1.fill_between(times, equity, max_eq, where=equity < max_eq, alpha=0.3, color="#F44336", label="Drawdown")

    ax1.set_ylabel("Equity (%)")
    ax1.legend(loc="upper left")
    ax1.grid(True, alpha=0.3)
    ax1.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m"))

    # Histogramme des PnL en R
    pnl_r = [t.pnl_r for t in trades]
    colors = ["#4CAF50" if r > 0 else "#F44336" for r in pnl_r]
    ax2.bar(range(len(pnl_r)), pnl_r, color=colors, width=0.8)
    ax2.axhline(0, color="gray", linewidth=0.8)
    ax2.set_xlabel("Trade #")
    ax2.set_ylabel("PnL (R)")
    ax2.grid(True, alpha=0.3, axis="y")

    # Stats en watermark
    stats_text = (
        f"Trades: {metrics['nb_trades']} | "
        f"Win: {metrics['win_rate_pct']:.0f}% | "
        f"PF: {metrics['profit_factor']:.2f} | "
        f"MDD: {metrics['max_drawdown_pct']:.1f}% | "
        f"Return: {metrics['total_return_pct']:+.1f}%"
    )
    fig.text(0.5, 0.01, stats_text, ha="center", fontsize=9, color="gray")

    plt.tight_layout(rect=[0, 0.03, 1, 1])
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()

    return path
