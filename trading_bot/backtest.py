"""
Backtest simple du bot SMC.
Rejoue la logique de signal_engine sur des données historiques Binance.
Lance : python trading_bot/backtest.py
"""

import sys
import time
import logging
from datetime import datetime, timezone

import ccxt
import pandas as pd

from config import TIMEFRAMES, API_RETRY_COUNT, API_RETRY_DELAY
from signal_engine import analyze_pair

# ── Paramètres backtest ──────────────────────────────────────────────────────
PAIR = "BTC/USDT"          # Paire à tester
MONTHS_BACK = 6            # Période à analyser (en mois)
MIN_CANDLES_HISTORY = 50   # Bougies min pour démarrer l'analyse
RESULT_FILE = "backtest_results.csv"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def create_exchange() -> ccxt.binance:
    return ccxt.binance({
        "options": {"defaultType": "future"},
        "enableRateLimit": True,
    })


def fetch_full_history(exchange: ccxt.binance, pair: str, timeframe: str, months: int) -> pd.DataFrame:
    """Télécharge l'historique complet via pagination ccxt."""
    limit_per_call = 500
    candles_needed = {
        "1d": months * 31,
        "4h": months * 31 * 6,
        "1h": months * 31 * 24,
        "15m": months * 31 * 24 * 4,
    }
    total_needed = min(candles_needed.get(timeframe, 500), 3000)

    logger.info(f"  Téléchargement {pair} {timeframe} — ~{total_needed} bougies...")

    all_ohlcv = []
    since = None

    while len(all_ohlcv) < total_needed:
        for attempt in range(1, API_RETRY_COUNT + 1):
            try:
                ohlcv = exchange.fetch_ohlcv(pair, timeframe=timeframe, since=since, limit=limit_per_call)
                break
            except ccxt.NetworkError as e:
                if attempt == API_RETRY_COUNT:
                    raise
                time.sleep(API_RETRY_DELAY * attempt)

        if not ohlcv:
            break

        all_ohlcv = ohlcv + all_ohlcv if since is None else all_ohlcv
        if len(ohlcv) < limit_per_call:
            break

        # Pagination vers le passé
        since = ohlcv[0][0] - (ohlcv[1][0] - ohlcv[0][0]) * limit_per_call
        all_ohlcv = ohlcv + all_ohlcv
        time.sleep(0.3)

        if len(all_ohlcv) >= total_needed:
            break

    df = pd.DataFrame(all_ohlcv[-total_needed:], columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df.set_index("timestamp").astype(float)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def check_outcome(signal: dict, future_df_15m: pd.DataFrame) -> dict:
    """
    Regarde les bougies 15m suivantes pour savoir si SL, TP1, TP2 ou TP3 a été touché en premier.
    Retourne outcome (str), candles_to_outcome (int), et max_adverse_excursion (%).
    """
    direction = signal["direction"]
    entry = signal["entry_price"]
    sl = signal["sl"]
    tp1 = signal["tp1"]
    tp2 = signal["tp2"]
    tp3 = signal["tp3"]

    outcome = "OPEN"
    candles_to_outcome = len(future_df_15m)
    mae = 0.0  # max adverse excursion

    for i, (_, candle) in enumerate(future_df_15m.iterrows()):
        high = candle["high"]
        low = candle["low"]

        if direction == "long":
            adverse = (entry - low) / entry * 100
            mae = max(mae, adverse)
            if low <= sl:
                outcome = "SL"
                candles_to_outcome = i + 1
                break
            if high >= tp3:
                outcome = "TP3"
                candles_to_outcome = i + 1
                break
            if high >= tp2:
                outcome = "TP2"
                candles_to_outcome = i + 1
                break
            if high >= tp1:
                outcome = "TP1"
                candles_to_outcome = i + 1
                break
        else:  # short
            adverse = (high - entry) / entry * 100
            mae = max(mae, adverse)
            if high >= sl:
                outcome = "SL"
                candles_to_outcome = i + 1
                break
            if low <= tp3:
                outcome = "TP3"
                candles_to_outcome = i + 1
                break
            if low <= tp2:
                outcome = "TP2"
                candles_to_outcome = i + 1
                break
            if low <= tp1:
                outcome = "TP1"
                candles_to_outcome = i + 1
                break

    return {
        "outcome": outcome,
        "candles_to_outcome": candles_to_outcome,
        "mae_pct": round(mae, 3),
    }


def run_backtest(pair: str, months: int) -> None:
    logger.info("=" * 60)
    logger.info(f"BACKTEST — {pair} — {months} derniers mois")
    logger.info("=" * 60)

    exchange = create_exchange()

    logger.info("Téléchargement des données historiques...")
    full_data = {}
    for tf_key in TIMEFRAMES:
        full_data[tf_key] = fetch_full_history(exchange, pair, tf_key, months)
        time.sleep(0.5)

    df_1h = full_data["1h"]
    df_15m = full_data["15m"]
    total_candles = len(df_1h)
    logger.info(f"Données prêtes — {total_candles} bougies 1H disponibles")
    logger.info("Début de la simulation...")

    results = []
    last_signal_ts = None  # anti-doublon 4h

    for i in range(MIN_CANDLES_HISTORY, total_candles):
        current_ts = df_1h.index[i]

        # Anti-doublon : skip si signal < 4h avant
        if last_signal_ts is not None:
            elapsed_h = (current_ts - last_signal_ts).total_seconds() / 3600
            if elapsed_h < 4:
                continue

        # Construire les slices de données comme le bot le ferait en live
        candles = {
            "1d": full_data["1d"][full_data["1d"].index <= current_ts].tail(200),
            "4h": full_data["4h"][full_data["4h"].index <= current_ts].tail(200),
            "1h": df_1h.iloc[:i + 1].tail(200),
            "15m": df_15m[df_15m.index <= current_ts].tail(200),
        }

        # Vérifier que chaque TF a assez de données
        if any(len(v) < MIN_CANDLES_HISTORY for v in candles.values()):
            continue

        signal = analyze_pair(pair, candles)

        if signal is None:
            continue

        last_signal_ts = current_ts

        # Bougies 15m futures pour évaluer le résultat
        future_15m = df_15m[df_15m.index > current_ts].head(200)

        if len(future_15m) == 0:
            continue

        outcome_data = check_outcome(signal, future_15m)

        result = {
            "date": current_ts.strftime("%Y-%m-%d %H:%M"),
            "direction": signal["direction"].upper(),
            "entry_price": round(signal["entry_price"], 4),
            "sl": round(signal["sl"], 4),
            "tp1": round(signal["tp1"], 4),
            "tp2": round(signal["tp2"], 4),
            "tp3": round(signal["tp3"], 4),
            "sl_pct": round(signal["sl_pct"], 2),
            "confluence_score": signal["confluence_score"],
            "tf_aligned": signal["tf_aligned"],
            "trigger": signal["trigger"],
            "rsi": signal["rsi"],
            "outcome": outcome_data["outcome"],
            "candles_to_outcome": outcome_data["candles_to_outcome"],
            "mae_pct": outcome_data["mae_pct"],
        }
        results.append(result)
        logger.info(
            f"  Signal #{len(results)} — {result['date']} — {result['direction']} "
            f"— Score {result['confluence_score']}/6 → {result['outcome']}"
        )

    if not results:
        logger.info("Aucun signal généré sur la période.")
        return

    df_results = pd.DataFrame(results)
    df_results.to_csv(RESULT_FILE, index=False)
    logger.info(f"\nRésultats sauvegardés dans : {RESULT_FILE}")

    # ── Statistiques ────────────────────────────────────────────────────────
    total = len(df_results)
    wins = df_results[df_results["outcome"].isin(["TP1", "TP2", "TP3"])]
    losses = df_results[df_results["outcome"] == "SL"]
    open_trades = df_results[df_results["outcome"] == "OPEN"]

    win_rate = len(wins) / (len(wins) + len(losses)) * 100 if (len(wins) + len(losses)) > 0 else 0

    logger.info("\n" + "=" * 60)
    logger.info(f"RÉSULTATS BACKTEST — {pair} — {months} mois")
    logger.info("=" * 60)
    logger.info(f"  Total signaux      : {total}")
    logger.info(f"  Gagnants (TP1+)    : {len(wins)}  ({win_rate:.1f}%)")
    logger.info(f"  Perdants (SL)      : {len(losses)}")
    logger.info(f"  En cours (OPEN)    : {len(open_trades)}")

    if len(wins) > 0:
        tp_counts = wins["outcome"].value_counts()
        logger.info(f"  Détail gains       : TP1={tp_counts.get('TP1', 0)}  TP2={tp_counts.get('TP2', 0)}  TP3={tp_counts.get('TP3', 0)}")

    logger.info(f"  MAE moy (adverse)  : {df_results['mae_pct'].mean():.3f}%")

    long_df = df_results[df_results["direction"] == "LONG"]
    short_df = df_results[df_results["direction"] == "SHORT"]
    if len(long_df) > 0:
        long_wins = long_df[long_df["outcome"].isin(["TP1", "TP2", "TP3"])]
        logger.info(f"  LONG  : {len(long_df)} signaux — {len(long_wins)} gagnants ({len(long_wins)/len(long_df)*100:.1f}%)")
    if len(short_df) > 0:
        short_wins = short_df[short_df["outcome"].isin(["TP1", "TP2", "TP3"])]
        logger.info(f"  SHORT : {len(short_df)} signaux — {len(short_wins)} gagnants ({len(short_wins)/len(short_df)*100:.1f}%)")

    logger.info("=" * 60)


if __name__ == "__main__":
    pair = sys.argv[1] if len(sys.argv) > 1 else PAIR
    months = int(sys.argv[2]) if len(sys.argv) > 2 else MONTHS_BACK
    run_backtest(pair, months)
