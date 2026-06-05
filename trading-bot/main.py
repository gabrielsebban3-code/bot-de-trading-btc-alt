"""
main.py
=======
Entry point for the SMC trading-signal bot.

Responsibilities:
    * Build the watch-list (top-N Binance Futures pairs by 24h volume + fixed).
    * Fetch multi-timeframe OHLCV for each pair.
    * Evaluate signals, apply anti-spam cooldown, and dispatch Discord alerts.
    * Run forever on a 5-minute scan loop, never crashing on API errors.

Run with:  ``python main.py``
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from datetime import datetime, timezone

import ccxt
import pandas as pd

import config
import discord_alert
import signals as sig_mod

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("bot")

# Dedicated file logger for emitted alerts (alerts.log).
_alert_logger = logging.getLogger("bot.alerts")
_alert_logger.setLevel(logging.INFO)
_alert_handler = logging.FileHandler(config.ALERTS_LOG_FILE, encoding="utf-8")
_alert_handler.setFormatter(logging.Formatter("%(asctime)s | %(message)s"))
_alert_logger.addHandler(_alert_handler)
_alert_logger.propagate = False


# --------------------------------------------------------------------------- #
# Anti-spam state : {pair: {direction: last_alert_epoch}}
# --------------------------------------------------------------------------- #
_last_alerts: dict[str, dict[str, float]] = {}


def _cooldown_active(pair: str, direction: str) -> bool:
    last = _last_alerts.get(pair, {}).get(direction)
    if last is None:
        return False
    return (time.time() - last) < config.ALERT_COOLDOWN_SECONDS


def _mark_alert(pair: str, direction: str) -> None:
    _last_alerts.setdefault(pair, {})[direction] = time.time()


# --------------------------------------------------------------------------- #
# Exchange layer (ccxt / Binance USDT-M futures)
# --------------------------------------------------------------------------- #
def build_exchange() -> ccxt.binanceusdm:
    """Create a ccxt Binance USDT-M futures client."""
    params = {"enableRateLimit": True, "options": {"defaultType": "future"}}
    if config.BINANCE_API_KEY and config.BINANCE_API_SECRET:
        params["apiKey"] = config.BINANCE_API_KEY
        params["secret"] = config.BINANCE_API_SECRET
    return ccxt.binanceusdm(params)


def _with_rate_limit_retry(fn, *args, retries: int = 3, **kwargs):
    """Call ``fn`` retrying on Binance rate-limit errors with a fixed backoff."""
    for attempt in range(retries):
        try:
            return fn(*args, **kwargs)
        except ccxt.RateLimitExceeded:
            logger.warning(
                "Rate limit hit; backing off %ss (attempt %d/%d)",
                config.RATE_LIMIT_BACKOFF_SECONDS,
                attempt + 1,
                retries,
            )
            time.sleep(config.RATE_LIMIT_BACKOFF_SECONDS)
        except ccxt.DDoSProtection:
            logger.warning("DDoS protection triggered; backing off %ss", config.RATE_LIMIT_BACKOFF_SECONDS)
            time.sleep(config.RATE_LIMIT_BACKOFF_SECONDS)
    # Final attempt (let the exception propagate to the caller's handler).
    return fn(*args, **kwargs)


def get_watchlist(exchange: ccxt.Exchange) -> list[str]:
    """
    Build the watch-list: top-N USDT perpetuals by 24h quote volume, plus the
    configured fixed pairs (de-duplicated, fixed pairs always included).
    """
    pairs: list[str] = []
    try:
        markets = exchange.load_markets()
        tickers = _with_rate_limit_retry(exchange.fetch_tickers)

        ranked = []
        for symbol, t in tickers.items():
            market = markets.get(symbol, {})
            if not market.get("swap"):
                continue
            if market.get("quote") != config.QUOTE_ASSET:
                continue
            qv = t.get("quoteVolume") or 0.0
            ranked.append((symbol, qv))

        ranked.sort(key=lambda x: x[1], reverse=True)
        # ccxt symbols look like "BTC/USDT:USDT" for perps -> normalise display.
        pairs = [s for s, _ in ranked[: config.TOP_N_PAIRS]]
    except ccxt.BaseError as exc:
        logger.error("Failed to fetch tickers for watch-list: %s", exc)

    # Always include the fixed pairs (mapped to their perp symbol if available).
    for fp in config.FIXED_PAIRS:
        perp = _resolve_symbol(exchange, fp)
        if perp and perp not in pairs:
            pairs.append(perp)

    return pairs


def _resolve_symbol(exchange: ccxt.Exchange, pair: str) -> str | None:
    """Map a 'BASE/QUOTE' pair to the available Binance perp symbol, if listed."""
    try:
        markets = exchange.markets or exchange.load_markets()
    except ccxt.BaseError:
        return None
    perp = f"{pair}:{config.QUOTE_ASSET}"
    if perp in markets:
        return perp
    if pair in markets:
        return pair
    return None


def _display_name(symbol: str) -> str:
    """'BTC/USDT:USDT' -> 'BTC/USDT' for alert display."""
    return symbol.split(":")[0]


def fetch_ohlcv_df(exchange: ccxt.Exchange, symbol: str, timeframe: str) -> pd.DataFrame | None:
    """Fetch OHLCV for one symbol+timeframe and return it as a DataFrame."""
    try:
        raw = _with_rate_limit_retry(
            exchange.fetch_ohlcv, symbol, timeframe=timeframe, limit=config.CANDLE_LIMIT
        )
    except ccxt.BaseError as exc:
        logger.error("OHLCV fetch failed for %s %s: %s", symbol, timeframe, exc)
        return None
    if not raw:
        return None
    df = pd.DataFrame(raw, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    return df


def fetch_pair_data(exchange: ccxt.Exchange, symbol: str) -> dict[str, pd.DataFrame]:
    """Fetch all timeframes for a pair, returning {tf_key: DataFrame}."""
    out: dict[str, pd.DataFrame] = {}
    for tf_key, tf_value in config.TIMEFRAMES.items():
        df = fetch_ohlcv_df(exchange, symbol, tf_value)
        if df is not None:
            out[tf_key] = df
    return out


# --------------------------------------------------------------------------- #
# Scan
# --------------------------------------------------------------------------- #
def scan_once(exchange: ccxt.Exchange) -> None:
    """Run a single scan over the entire watch-list."""
    watchlist = get_watchlist(exchange)
    logger.info("Scanning %d pairs: %s", len(watchlist), ", ".join(_display_name(s) for s in watchlist))

    for symbol in watchlist:
        display = _display_name(symbol)
        try:
            data = fetch_pair_data(exchange, symbol)
            signal = sig_mod.evaluate_pair(display, data)

            if signal is None:
                logger.info("[%s] no signal", display)
                continue

            if _cooldown_active(display, signal.direction):
                logger.info(
                    "[%s] %s signal suppressed (cooldown active)", display, signal.direction.upper()
                )
                continue

            logger.info(
                "[%s] %s SIGNAL  score=%d/6  trigger=%s",
                display,
                signal.direction.upper(),
                signal.score,
                signal.trigger,
            )
            sent = discord_alert.send_signal(signal)
            if sent:
                _mark_alert(display, signal.direction)
                _log_alert(signal)
        except ccxt.BaseError as exc:
            logger.error("[%s] exchange error: %s", display, exc)
        except Exception as exc:  # noqa: BLE001 - never crash the loop
            logger.exception("[%s] unexpected error: %s", display, exc)


def _log_alert(signal: sig_mod.Signal) -> None:
    """Persist an emitted alert to alerts.log."""
    tps = ", ".join(f"TP{i}={tp:.6g}" for i, tp in enumerate(signal.take_profits, 1))
    _alert_logger.info(
        "%s %s | score=%d/6 | entry=%.6g-%.6g | SL=%.6g | %s | RSI=%.1f | ATR=%s | trigger=%s",
        signal.pair,
        signal.direction.upper(),
        signal.score,
        signal.entry_low,
        signal.entry_high,
        signal.stop_loss,
        tps,
        signal.rsi_1h,
        signal.atr_label,
        signal.trigger,
    )


# --------------------------------------------------------------------------- #
# Loop
# --------------------------------------------------------------------------- #
async def run_loop() -> None:
    exchange = build_exchange()
    logger.info("Bot started. Scan interval = %ds", config.SCAN_INTERVAL_SECONDS)
    if not config.DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL not set — alerts will be logged but not delivered.")

    while True:
        started = datetime.now(timezone.utc)
        try:
            scan_once(exchange)
        except Exception as exc:  # noqa: BLE001 - bullet-proof the loop
            logger.exception("Scan cycle failed: %s", exc)

        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        sleep_for = max(0, config.SCAN_INTERVAL_SECONDS - elapsed)
        logger.info("Scan complete in %.1fs. Sleeping %.0fs.", elapsed, sleep_for)
        await asyncio.sleep(sleep_for)


def main() -> None:
    try:
        asyncio.run(run_loop())
    except KeyboardInterrupt:
        logger.info("Shutting down (keyboard interrupt).")


if __name__ == "__main__":
    main()
