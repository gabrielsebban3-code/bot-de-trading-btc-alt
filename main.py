"""
Point d'entrée du Bot Intraday.

Boucle principale :
  1. Attend la clôture de la prochaine bougie 15m (+ buffer).
  2. Scanne tous les symboles (modules Crash Bounce + Trend).
  3. Envoie les nouvelles alertes sur Discord (anti-doublon).
  4. Recommence.

Conçu pour tourner en continu comme un "worker" (Railway, VPS, etc.).
"""

import time
import logging
from datetime import datetime, timezone

import config
from src import signal_engine, discord_notifier
from src.utils import setup_logging, SignalDeduper

logger = logging.getLogger("bot.main")

# Durée d'une bougie d'entrée en secondes (15m = 900s).
_INTERVAL_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600}


def _seconds_until_next_close(interval: str) -> float:
    """Secondes restantes avant la prochaine clôture de bougie, + buffer."""
    step = _INTERVAL_SECONDS.get(interval, 900)
    now = time.time()
    next_close = (int(now // step) + 1) * step
    return (next_close - now) + config.POST_CLOSE_BUFFER_SEC


def _run_scan(deduper: SignalDeduper) -> None:
    started = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    logger.info("=== Scan démarré (%s) sur %d symboles ===", started, len(config.SYMBOLS))

    signals = signal_engine.scan_all()

    sent = 0
    for sig in signals:
        if deduper.is_new(sig["symbol"], sig["mode"], sig["candle_time"]):
            if discord_notifier.send_signal(sig):
                sent += 1
        else:
            logger.info("Doublon ignoré : %s %s", sig["symbol"], sig["mode"])

    logger.info("=== Scan terminé : %d signal(aux), %d alerte(s) envoyée(s) ===",
                len(signals), sent)


def main() -> None:
    setup_logging()
    logger.info("Bot Intraday — démarrage")
    logger.info("Symboles : %s", ", ".join(config.SYMBOLS))
    logger.info("Timeframes : tendance=%s | entrée=%s", config.TF_TREND, config.TF_ENTRY)

    if not config.DISCORD_WEBHOOK_URL:
        logger.warning("⚠️  DISCORD_WEBHOOK_URL n'est pas configurée. "
                       "Les signaux seront loggés mais PAS envoyés sur Discord.")
    elif config.SEND_STARTUP_MESSAGE:
        discord_notifier.send_text(
            "🤖 **Bot Intraday en ligne** — surveillance de "
            f"{len(config.SYMBOLS)} cryptos (tendance {config.TF_TREND} / "
            f"entrée {config.TF_ENTRY}). Modules actifs : Trend + Crash Bounce."
        )

    deduper = SignalDeduper()

    # Scan immédiat optionnel au démarrage (mode test).
    if config.RUN_ON_START:
        logger.info("RUN_ON_START actif : scan immédiat.")
        _run_scan(deduper)

    # Boucle principale.
    while True:
        wait = _seconds_until_next_close(config.TF_ENTRY)
        logger.info("Prochaine analyse dans %.0f s.", wait)
        time.sleep(wait)
        try:
            _run_scan(deduper)
        except Exception as exc:  # une erreur de scan ne doit jamais tuer le bot
            logger.exception("Erreur durant le scan : %s", exc)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Arrêt manuel du bot.")
