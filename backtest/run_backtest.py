"""
Point d'entrée du backtest.
Télécharge ~1 mois de données historiques via ccxt (Binance Futures, public),
rejoue barre par barre, calcule les métriques et génère les sorties.

Usage :
    python -m backtest.run_backtest
    python -m backtest.run_backtest --symbols BTC/USDT,ETH/USDT --days 30
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import ccxt.async_support as ccxt
import pandas as pd

from backtest.engine import run_backtest_symbol
from backtest.metrics import (
    compute_metrics,
    plot_equity_curve,
    save_summary,
    save_trades_csv,
)
from strategy.config import FEE_PERCENT, SLIPPAGE_PERCENT, SYMBOLS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# Taille d'une page de klines Binance (maximum)
BINANCE_KLINES_PAGE = 1500


# ─── Téléchargement des données ───────────────────────────────────────────────

async def fetch_ohlcv_full(
    exchange: ccxt.Exchange,
    symbol: str,
    timeframe: str,
    since_ms: int,
    until_ms: int,
) -> pd.DataFrame:
    """
    Télécharge toutes les bougies d'un symbole entre since_ms et until_ms.
    Pagine automatiquement pour contourner la limite de 1500 bougies par requête.
    """
    all_bars: list[list] = []
    current_since = since_ms

    tf_ms = {
        "1m": 60_000,
        "3m": 180_000,
        "5m": 300_000,
        "15m": 900_000,
    }[timeframe]

    while current_since < until_ms:
        try:
            bars = await exchange.fetch_ohlcv(
                symbol,
                timeframe=timeframe,
                since=current_since,
                limit=BINANCE_KLINES_PAGE,
            )
        except Exception as e:
            logger.warning("Erreur fetch %s %s : %s — retry dans 5s", symbol, timeframe, e)
            await asyncio.sleep(5)
            continue

        if not bars:
            break

        all_bars.extend(bars)
        last_ts = bars[-1][0]

        if last_ts >= until_ms or len(bars) < BINANCE_KLINES_PAGE:
            break

        current_since = last_ts + tf_ms
        await asyncio.sleep(0.3)  # respecter les rate limits

    if not all_bars:
        return pd.DataFrame()

    df = pd.DataFrame(all_bars, columns=["timestamp_ms", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True)
    df = df[df["timestamp_ms"] <= until_ms].copy()
    df = df.drop_duplicates("timestamp_ms").sort_values("timestamp_ms").reset_index(drop=True)
    df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype(
        {"open": float, "high": float, "low": float, "close": float, "volume": float}
    )

    logger.info("  %s %s : %d bougies téléchargées", symbol, timeframe, len(df))
    return df


async def download_all(
    symbols: list[str],
    days: int = 30,
) -> dict[str, dict[str, pd.DataFrame]]:
    """
    Télécharge les données 1m et 5m pour chaque symbole.
    Retourne un dict {symbol: {"1m": df, "5m": df}}.
    """
    exchange = ccxt.binanceusdm({"enableRateLimit": True})
    await exchange.load_markets()

    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    since_ms = int(since.timestamp() * 1000)
    until_ms = int(now.timestamp() * 1000)

    data: dict[str, dict[str, pd.DataFrame]] = {}

    for symbol in symbols:
        logger.info("Téléchargement %s...", symbol)
        # Convertir le format ccxt : BTC/USDT → BTCUSDT pour les futures
        sym_clean = symbol.replace("/", "")
        _ = sym_clean  # inutilisé, ccxt gère la conversion

        df_1m = await fetch_ohlcv_full(exchange, symbol, "1m", since_ms, until_ms)
        df_5m = await fetch_ohlcv_full(exchange, symbol, "5m", since_ms, until_ms)

        if df_1m.empty or df_5m.empty:
            logger.warning("%s : données vides, skip", symbol)
            continue

        data[symbol] = {"1m": df_1m, "5m": df_5m}

    await exchange.close()
    return data


# ─── Orchestration principale ─────────────────────────────────────────────────

async def main(symbols: list[str], days: int) -> None:
    print("\n" + "=" * 60)
    print("  BACKTEST — Trend-Pullback Scalper")
    print(f"  Paires : {', '.join(symbols)}")
    print(f"  Période : {days} jours")
    print(f"  Frais : {FEE_PERCENT}% taker | Slippage : {SLIPPAGE_PERCENT}%")
    print("=" * 60)

    # 1. Téléchargement
    print("\n[1/4] Téléchargement des données historiques...")
    data = await download_all(symbols, days)

    if not data:
        print("Aucune donnée téléchargée. Vérifiez votre connexion et les symboles.")
        sys.exit(1)

    actual_symbols = list(data.keys())

    # 2. Backtest par symbole
    print(f"\n[2/4] Replay barre-par-barre sur {len(actual_symbols)} paire(s)...")
    all_trades = []

    for symbol in actual_symbols:
        df_1m = data[symbol]["1m"]
        df_5m = data[symbol]["5m"]
        trades = run_backtest_symbol(symbol, df_1m, df_5m)
        all_trades.extend(trades)
        logger.info("%s : %d trades générés", symbol, len(trades))

    print(f"  Total trades : {len(all_trades)}")

    # 3. Métriques
    print("\n[3/4] Calcul des métriques...")
    metrics = compute_metrics(all_trades)

    # Dates réelles de la période
    all_1m = pd.concat([data[s]["1m"] for s in actual_symbols])
    period_start = all_1m["timestamp"].min().to_pydatetime()
    period_end = all_1m["timestamp"].max().to_pydatetime()

    # 4. Sauvegarde
    print("\n[4/4] Génération des fichiers de résultats...")
    if all_trades:
        csv_path = save_trades_csv(all_trades)
        print(f"  Trades CSV   : {csv_path}")

    summary_path = save_summary(metrics, actual_symbols, period_start, period_end)
    print(f"  Summary      : {summary_path}")

    if all_trades:
        chart_path = plot_equity_curve(all_trades, metrics)
        if chart_path:
            print(f"  Equity chart : {chart_path}")

    # Affichage final
    print("\n" + "=" * 60)
    print("  RÉSULTATS")
    print("=" * 60)
    print(f"  Nb trades       : {metrics.get('nb_trades', 0)}")
    print(f"  Win rate        : {metrics.get('win_rate_pct', 0):.1f}%")
    print(f"  Avg win (R)     : {metrics.get('avg_win_r', 0):.2f}R")
    print(f"  Avg loss (R)    : {metrics.get('avg_loss_r', 0):.2f}R")
    print(f"  Profit factor   : {metrics.get('profit_factor', 0):.2f}")
    print(f"  Expectancy      : {metrics.get('expectancy_r', 0):.2f}R / trade")
    print(f"  Max drawdown    : {metrics.get('max_drawdown_pct', 0):.2f}%")
    print(f"  Return total    : {metrics.get('total_return_pct', 0):.2f}%")
    print(f"  Sharpe annuel   : {metrics.get('sharpe_annualized', 0):.2f}")
    print("=" * 60 + "\n")

    exit_reasons = metrics.get("exit_reasons", {})
    if exit_reasons:
        print("  Sorties :")
        for reason, count in sorted(exit_reasons.items()):
            print(f"    {reason:<6} : {count} ({count/len(all_trades)*100:.1f}%)")
        print()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backtest Trend-Pullback Scalper")
    parser.add_argument(
        "--symbols",
        type=str,
        default=None,
        help="Paires séparées par virgule (ex: BTC/USDT,ETH/USDT)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Nombre de jours d'historique (défaut: 30)",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    symbols = args.symbols.split(",") if args.symbols else SYMBOLS[:3]  # 3 paires par défaut
    asyncio.run(main(symbols, args.days))
