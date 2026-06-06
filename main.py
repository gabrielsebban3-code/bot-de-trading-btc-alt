"""
Trading bot main loop.
Scans all configured pairs on every SCAN_INTERVAL_SECONDS cycle.
"""

import logging
import time
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from config import PAIRS, SCAN_INTERVAL_SECONDS
from signals.signal_generator import generate_signal
from discord.webhook import send_signal

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("main")


def scan_once() -> None:
    logger.info("Starting scan of %d pairs…", len(PAIRS))
    for symbol in PAIRS:
        logger.info("Analysing %s…", symbol)
        try:
            signal = generate_signal(symbol)
            if signal:
                logger.info(
                    "Signal found: %s %s (score %d/6)",
                    signal.direction.upper(), signal.symbol, signal.confluence_score,
                )
                send_signal(signal)
            else:
                logger.info("No signal for %s", symbol)
        except Exception:
            logger.exception("Unexpected error processing %s", symbol)
    logger.info("Scan complete.")


def main() -> None:
    logger.info("Bot started. Scanning every %d seconds.", SCAN_INTERVAL_SECONDS)
    while True:
        start = time.time()
        scan_once()
        elapsed = time.time() - start
        sleep_for = max(0.0, SCAN_INTERVAL_SECONDS - elapsed)
        logger.info("Next scan in %.0f seconds.", sleep_for)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
