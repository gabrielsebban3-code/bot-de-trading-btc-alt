"""
main.py — Point d'entrée du bot de trading.

  - Récupère les données Binance Futures (USDT perpétuels) via ccxt
  - Analyse chaque paire sur 4 timeframes (1D / 4H / 1H / 15m)
  - Détecte les signaux LONG / SHORT (logique dans signals.py)
  - Envoie une alerte Discord (discord_alert.py)
  - Boucle toutes les 5 minutes, sans jamais crasher
  - Anti-spam : pas de re-signal même paire + direction pendant 4h
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

import ccxt
from dotenv import load_dotenv

import config
import indicators
import signals
from discord_alert import send_alert

load_dotenv()

# ---------------------------------------------------------------------------
# LOGGING : console + fichier alerts.log
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(config.ALERTS_LOG_FILE, encoding="utf-8"),
    ],
)
logger = logging.getLogger("bot")

# ---------------------------------------------------------------------------
# CLIENT BINANCE (ccxt) — Futures USDT, données publiques (pas besoin de clés)
# ---------------------------------------------------------------------------
exchange = ccxt.binance(
    {
        "enableRateLimit": True,
        "options": {"defaultType": "future"},
    }
)

# Anti-spam : {pair: {direction: last_alert_timestamp}}
last_alerts: dict[str, dict[str, float]] = {}


def fetch_ohlcv_df(symbol: str, timeframe: str):
    """
    Récupère les bougies OHLCV depuis Binance et renvoie un DataFrame pandas.
    Gère les rate-limits (attente puis retry une fois).
    """
    import pandas as pd

    for attempt in range(2):
        try:
            ohlcv = exchange.fetch_ohlcv(
                symbol, timeframe=timeframe, limit=config.CANDLE_LIMIT
            )
            df = pd.DataFrame(
                ohlcv,
                columns=["timestamp", "open", "high", "low", "close", "volume"],
            )
            return df
        except ccxt.RateLimitExceeded:
            logger.warning(
                "Rate limit Binance atteint (%s %s), attente %ss…",
                symbol,
                timeframe,
                config.RATE_LIMIT_SLEEP_SECONDS,
            )
            time.sleep(config.RATE_LIMIT_SLEEP_SECONDS)
        except ccxt.BaseError as exc:
            logger.error("Erreur API Binance (%s %s) : %s", symbol, timeframe, exc)
            return None
    return None


def is_on_cooldown(pair: str, direction: str) -> bool:
    """True si un signal identique a été envoyé il y a moins de COOLDOWN_HOURS."""
    entry = last_alerts.get(pair, {}).get(direction)
    if entry is None:
        return False
    elapsed = time.time() - entry
    return elapsed < config.COOLDOWN_HOURS * 3600


def register_alert(pair: str, direction: str) -> None:
    last_alerts.setdefault(pair, {})[direction] = time.time()


def scan_pair(pair: str) -> None:
    """Analyse une paire sur tous les timeframes et émet un signal le cas échéant."""
    analyses = {}
    for tf_key, tf_value in config.TIMEFRAMES.items():
        df = fetch_ohlcv_df(pair, tf_value)
        if df is None or len(df) < 210:  # besoin d'au moins EMA200 + structure
            logger.info("%-12s | données insuffisantes (%s) — skip", pair, tf_key)
            return
        analyses[tf_key] = indicators.analyze_timeframe(df)

    signal = signals.detect_signal(analyses)

    if not signal:
        logger.info("%-12s | pas de signal", pair)
        return

    direction = signal["direction"]

    if is_on_cooldown(pair, direction):
        logger.info(
            "%-12s | signal %s détecté mais en cooldown (anti-spam)",
            pair,
            direction.upper(),
        )
        return

    logger.info(
        "%-12s | SIGNAL %s — score %s/6, %s/4 TF alignés",
        pair,
        direction.upper(),
        signal["score"],
        signal["aligned_count"],
    )

    if send_alert(pair, signal):
        register_alert(pair, direction)
        logger.info("%-12s | alerte Discord envoyée ✅", pair)
    else:
        logger.error("%-12s | échec d'envoi de l'alerte Discord", pair)


async def scan_loop() -> None:
    """Boucle de scan continue, exécutée toutes les SCAN_INTERVAL_SECONDS."""
    logger.info("=== Bot de trading démarré — %d paires surveillées ===", len(config.PAIRS))
    while True:
        cycle_start = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        logger.info("----- Nouveau cycle de scan @ %s -----", cycle_start)

        for pair in config.PAIRS:
            try:
                scan_pair(pair)
            except Exception as exc:  # noqa: BLE001 — la boucle ne doit jamais crasher
                logger.exception("Erreur inattendue en scannant %s : %s", pair, exc)

        logger.info(
            "Cycle terminé — prochaine analyse dans %d s", config.SCAN_INTERVAL_SECONDS
        )
        await asyncio.sleep(config.SCAN_INTERVAL_SECONDS)


def main() -> None:
    try:
        asyncio.run(scan_loop())
    except KeyboardInterrupt:
        logger.info("Arrêt manuel du bot.")


if __name__ == "__main__":
    main()
