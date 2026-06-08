"""
Backtest fidèle au bot SMC.
Rejoue exactement la logique du bot réel : scan toutes les 15 minutes,
mêmes données, mêmes conditions. Résultats cohérents avec le bot live.
Lance : python trading_bot/backtest.py
"""

import sys
import time
import logging
from datetime import datetime, timedelta, timezone

import ccxt
import pandas as pd

from config import TIMEFRAMES, API_RETRY_COUNT, API_RETRY_DELAY, SIGNAL_COOLDOWN
from signal_engine import analyze_pair

# ── Paramètres backtest ──────────────────────────────────────────────────────
PAIR = "BTC/USDT"
MONTHS_BACK = 6
MIN_CANDLES_HISTORY = 50
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


def months_ago_ms(months: int) -> int:
    """Retourne le timestamp en ms d'il y a N mois."""
    since_dt = datetime.now(timezone.utc) - timedelta(days=months * 31)
    return int(since_dt.timestamp() * 1000)


def fetch_full_history(exchange: ccxt.binance, pair: str, timeframe: str, since_ms: int) -> pd.DataFrame:
    """
    Télécharge tout l'historique depuis since_ms jusqu'à maintenant.
    Pagination correcte : avance candle par candle jusqu'à la fin.
    """
    limit_per_call = 1000
    all_ohlcv = []
    current_since = since_ms

    logger.info(f"  Téléchargement {pair} {timeframe}...")

    while True:
        for attempt in range(1, API_RETRY_COUNT + 1):
            try:
                ohlcv = exchange.fetch_ohlcv(
                    pair, timeframe=timeframe,
                    since=current_since, limit=limit_per_call
                )
                break
            except ccxt.NetworkError as e:
                if attempt == API_RETRY_COUNT:
                    raise
                time.sleep(API_RETRY_DELAY * attempt)

        if not ohlcv:
            break

        all_ohlcv.extend(ohlcv)

        if len(ohlcv) < limit_per_call:
            break

        # Avancer au-delà de la dernière bougie reçue
        current_since = ohlcv[-1][0] + 1
        time.sleep(0.25)

    if not all_ohlcv:
        return pd.DataFrame()

    df = pd.DataFrame(all_ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df = df.set_index("timestamp").astype(float)
    df = df[~df.index.duplicated(keep="last")].sort_index()

    logger.info(f"    → {len(df)} bougies téléchargées")
    return df


def check_outcome(signal: dict, future_df_15m: pd.DataFrame) -> dict:
    """
    Parcourt les bougies 15m suivant le signal pour trouver le premier
    niveau touché : SL, TP1, TP2 ou TP3.
    """
    direction = signal["direction"]
    entry = signal["entry_price"]
    sl = signal["sl"]
    tp1 = signal["tp1"]
    tp2 = signal["tp2"]
    tp3 = signal["tp3"]

    outcome = "OPEN"
    candles_to_outcome = len(future_df_15m)
    mae = 0.0

    for i, (_, candle) in enumerate(future_df_15m.iterrows()):
        high = candle["high"]
        low = candle["low"]

        if direction == "long":
            mae = max(mae, (entry - low) / entry * 100)
            if low <= sl:
                outcome, candles_to_outcome = "SL", i + 1
                break
            if high >= tp3:
                outcome, candles_to_outcome = "TP3", i + 1
                break
            if high >= tp2:
                outcome, candles_to_outcome = "TP2", i + 1
                break
            if high >= tp1:
                outcome, candles_to_outcome = "TP1", i + 1
                break
        else:
            mae = max(mae, (high - entry) / entry * 100)
            if high >= sl:
                outcome, candles_to_outcome = "SL", i + 1
                break
            if low <= tp3:
                outcome, candles_to_outcome = "TP3", i + 1
                break
            if low <= tp2:
                outcome, candles_to_outcome = "TP2", i + 1
                break
            if low <= tp1:
                outcome, candles_to_outcome = "TP1", i + 1
                break

    return {
        "outcome": outcome,
        "candles_to_outcome": candles_to_outcome,
        "mae_pct": round(mae, 3),
    }


def run_backtest(pair: str, months: int) -> None:
    logger.info("=" * 60)
    logger.info(f"BACKTEST FIDÈLE — {pair} — {months} derniers mois")
    logger.info(f"Simulation scan toutes les 15 minutes (comme le bot réel)")
    logger.info("=" * 60)

    exchange = create_exchange()
    since_ms = months_ago_ms(months)

    # Télécharger suffisamment de données : période demandée + 200 bougies
    # d'historique supplémentaire pour que les indicateurs soient précis dès le début
    extra_days = {
        "1d": 200,
        "4h": 200 * 4 // 24 + 1,
        "1h": 200,
        "15m": 200 // 4 + 1,
    }
    tf_interval_ms = {
        "1d": 86400 * 1000,
        "4h": 4 * 3600 * 1000,
        "1h": 3600 * 1000,
        "15m": 15 * 60 * 1000,
    }

    logger.info("Téléchargement des données historiques...")
    full_data = {}
    for tf_key in TIMEFRAMES:
        warmup_ms = extra_days[tf_key] * tf_interval_ms[tf_key]
        full_data[tf_key] = fetch_full_history(exchange, pair, tf_key, since_ms - warmup_ms)
        time.sleep(0.5)

    df_15m = full_data["15m"]
    if df_15m.empty:
        logger.error("Impossible de télécharger les données 15m.")
        return

    # Index des autres TF pour le searchsorted rapide
    idx_1d = full_data["1d"].index
    idx_4h = full_data["4h"].index
    idx_1h = full_data["1h"].index
    idx_15m = df_15m.index

    # On ne simule que depuis la date demandée (les données avant servent au warmup)
    start_ts = pd.Timestamp(since_ms, unit="ms", tz="UTC")
    sim_positions = [i for i, ts in enumerate(idx_15m) if ts >= start_ts]

    if not sim_positions:
        logger.error("Aucune donnée dans la période demandée.")
        return

    logger.info(f"Données prêtes — simulation sur {len(sim_positions)} scans de 15 minutes")
    logger.info("Début de la simulation (peut prendre quelques minutes)...")

    results = []
    last_signal_ts = None
    progress_step = max(1, len(sim_positions) // 20)  # log tous les 5%

    for count, i in enumerate(sim_positions):
        current_ts = idx_15m[i]

        # Log de progression toutes les 5%
        if count % progress_step == 0:
            pct = count / len(sim_positions) * 100
            logger.info(f"  Progression : {pct:.0f}% — {current_ts.strftime('%Y-%m-%d %H:%M')}")

        # Anti-doublon : même cooldown 4h que le bot réel
        if last_signal_ts is not None:
            elapsed = (current_ts - last_signal_ts).total_seconds()
            if elapsed < SIGNAL_COOLDOWN:
                continue

        # Découper les données exactement comme le bot le ferait à cet instant
        i_1d = idx_1d.searchsorted(current_ts, side="right")
        i_4h = idx_4h.searchsorted(current_ts, side="right")
        i_1h = idx_1h.searchsorted(current_ts, side="right")

        candles = {
            "1d": full_data["1d"].iloc[max(0, i_1d - 200):i_1d],
            "4h": full_data["4h"].iloc[max(0, i_4h - 200):i_4h],
            "1h": full_data["1h"].iloc[max(0, i_1h - 200):i_1h],
            "15m": df_15m.iloc[max(0, i - 199):i + 1],
        }

        if any(len(v) < MIN_CANDLES_HISTORY for v in candles.values()):
            continue

        signal = analyze_pair(pair, candles)

        if signal is None:
            continue

        last_signal_ts = current_ts

        # Bougies 15m futures pour évaluer le résultat (200 bougies = ~50h)
        future_15m = df_15m.iloc[i + 1:i + 201]

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
            f"  ✦ Signal #{len(results)} — {result['date']} — {result['direction']} "
            f"— Score {result['confluence_score']}/6 → {result['outcome']}"
        )

    if not results:
        logger.info("Aucun signal généré sur la période.")
        return

    df_results = pd.DataFrame(results)
    df_results.to_csv(RESULT_FILE, index=False)
    logger.info(f"\nRésultats sauvegardés dans : {RESULT_FILE}")

    # ── Statistiques finales ─────────────────────────────────────────────────
    wins = df_results[df_results["outcome"].isin(["TP1", "TP2", "TP3"])]
    losses = df_results[df_results["outcome"] == "SL"]
    open_trades = df_results[df_results["outcome"] == "OPEN"]
    decided = len(wins) + len(losses)
    win_rate = len(wins) / decided * 100 if decided > 0 else 0

    logger.info("\n" + "=" * 60)
    logger.info(f"RÉSULTATS — {pair} — {months} mois")
    logger.info("=" * 60)
    logger.info(f"  Total signaux      : {len(df_results)}")
    logger.info(f"  Gagnants (TP1+)    : {len(wins)}  ({win_rate:.1f}%)")
    logger.info(f"  Perdants (SL)      : {len(losses)}")
    logger.info(f"  En cours (OPEN)    : {len(open_trades)}")

    if len(wins) > 0:
        tp_counts = wins["outcome"].value_counts()
        logger.info(
            f"  Détail gains       : "
            f"TP1={tp_counts.get('TP1', 0)}  "
            f"TP2={tp_counts.get('TP2', 0)}  "
            f"TP3={tp_counts.get('TP3', 0)}"
        )

    logger.info(f"  MAE moy (adverse)  : {df_results['mae_pct'].mean():.3f}%")

    long_df = df_results[df_results["direction"] == "LONG"]
    short_df = df_results[df_results["direction"] == "SHORT"]
    if len(long_df) > 0:
        lw = long_df[long_df["outcome"].isin(["TP1", "TP2", "TP3"])]
        logger.info(f"  LONG  : {len(long_df)} signaux — {len(lw)} gagnants ({len(lw)/len(long_df)*100:.1f}%)")
    if len(short_df) > 0:
        sw = short_df[short_df["outcome"].isin(["TP1", "TP2", "TP3"])]
        logger.info(f"  SHORT : {len(short_df)} signaux — {len(sw)} gagnants ({len(sw)/len(short_df)*100:.1f}%)")

    logger.info("=" * 60)


if __name__ == "__main__":
    pair = sys.argv[1] if len(sys.argv) > 1 else PAIR
    months = int(sys.argv[2]) if len(sys.argv) > 2 else MONTHS_BACK
    run_backtest(pair, months)
