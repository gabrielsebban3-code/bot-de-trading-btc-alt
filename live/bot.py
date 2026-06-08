"""
Bot live — boucle principale async.
Tourne 24h/24 sur Railway, analyse toutes les paires toutes les N secondes.
N'émet aucun ordre réel : alertes Discord uniquement.
"""
from __future__ import annotations

import asyncio
import logging
import signal as os_signal
import sys
from datetime import datetime, timezone
from typing import Optional

import aiohttp
import ccxt.async_support as ccxt
import pandas as pd

from live.discord_client import send_signal, send_startup_message
from live.signal_manager import SignalManager
from strategy.config import (
    DISCORD_WEBHOOK_URL,
    KLINES_LIMIT,
    SCAN_INTERVAL_SECONDS,
    SYMBOLS,
)
from strategy.indicators import compute_all
from strategy.strategy import Signal, evaluate

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


# ─── Fetch des klines ─────────────────────────────────────────────────────────

async def fetch_klines(
    exchange: ccxt.Exchange,
    symbol: str,
    timeframe: str,
    limit: int = KLINES_LIMIT,
) -> Optional[pd.DataFrame]:
    """
    Récupère les dernières `limit` bougies pour symbol/timeframe.
    Retourne None en cas d'erreur (la boucle principale continue).
    """
    try:
        bars = await exchange.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        if not bars or len(bars) < 60:
            return None

        df = pd.DataFrame(bars, columns=["timestamp_ms", "open", "high", "low", "close", "volume"])
        df["timestamp"] = pd.to_datetime(df["timestamp_ms"], unit="ms", utc=True)
        df = df[["timestamp", "open", "high", "low", "close", "volume"]].astype(
            {"open": float, "high": float, "low": float, "close": float, "volume": float}
        )
        return df
    except ccxt.NetworkError as e:
        logger.warning("Network error %s %s : %s", symbol, timeframe, e)
    except ccxt.ExchangeError as e:
        logger.warning("Exchange error %s %s : %s", symbol, timeframe, e)
    except Exception as e:
        logger.error("Erreur inattendue fetch %s %s : %s", symbol, timeframe, e)
    return None


# ─── Analyse d'une paire ──────────────────────────────────────────────────────

async def analyze_symbol(
    exchange: ccxt.Exchange,
    symbol: str,
    signal_manager: SignalManager,
    http_session: aiohttp.ClientSession,
) -> Optional[Signal]:
    """
    Fetch + calcul indicateurs + évaluation stratégie pour un symbole.
    Retourne le Signal émis (ou None).
    """
    # Récupération concurrente des deux timeframes
    df_5m, df_1m = await asyncio.gather(
        fetch_klines(exchange, symbol, "5m"),
        fetch_klines(exchange, symbol, "1m"),
    )

    if df_5m is None or df_1m is None:
        return None

    # Calcul des indicateurs
    df_5m = compute_all(df_5m)
    df_1m = compute_all(df_1m)

    # Évaluation de la stratégie (logique partagée avec le backtest)
    signal = evaluate(df_5m, df_1m, symbol)

    if signal is None:
        return None

    # Vérification cooldown / dédoublonnage
    if not signal_manager.is_allowed(signal):
        return None

    # Envoi Discord
    sent = await send_signal(DISCORD_WEBHOOK_URL, signal, http_session)
    if sent:
        signal_manager.record(signal)
        logger.info(
            "SIGNAL %s %s | entry=%.4f sl=%.4f tp2=%.4f rr=%.2f score=%d",
            signal.symbol,
            signal.side,
            signal.entry,
            signal.sl,
            signal.tp2,
            signal.rr,
            signal.score,
        )

    return signal


# ─── Boucle principale ────────────────────────────────────────────────────────

class TradingBot:
    def __init__(self, symbols: list[str] = SYMBOLS) -> None:
        self.symbols = symbols
        self.signal_manager = SignalManager()
        self._running = False
        self._scan_count = 0
        self._signal_count = 0

    async def run(self) -> None:
        """Démarre la boucle infinie d'analyse."""
        self._running = True

        exchange = ccxt.binanceusdm({"enableRateLimit": True})
        await exchange.load_markets()

        connector = aiohttp.TCPConnector(limit=20)
        async with aiohttp.ClientSession(connector=connector) as http_session:
            # Message de démarrage
            await send_startup_message(DISCORD_WEBHOOK_URL, http_session, self.symbols)
            logger.info(
                "Bot démarré — %d paires | interval=%ds | cooldown=%dmin",
                len(self.symbols),
                SCAN_INTERVAL_SECONDS,
                int(self.signal_manager._cooldown.total_seconds() / 60),
            )

            try:
                while self._running:
                    scan_start = asyncio.get_event_loop().time()
                    await self._scan_all(exchange, http_session)
                    self._scan_count += 1

                    # Nettoyage périodique du gestionnaire de signaux (toutes les 100 scans)
                    if self._scan_count % 100 == 0:
                        self.signal_manager.cleanup_expired()

                    # Attendre jusqu'au prochain intervalle
                    elapsed = asyncio.get_event_loop().time() - scan_start
                    wait = max(0.0, SCAN_INTERVAL_SECONDS - elapsed)
                    if wait > 0:
                        await asyncio.sleep(wait)

            except asyncio.CancelledError:
                logger.info("Bot arrêté proprement.")
            finally:
                await exchange.close()

    async def _scan_all(
        self,
        exchange: ccxt.Exchange,
        http_session: aiohttp.ClientSession,
    ) -> None:
        """Analyse toutes les paires en parallèle (par batch pour éviter d'inonder l'exchange)."""
        batch_size = 5  # analyses concurrentes max
        signals_this_scan = 0

        for i in range(0, len(self.symbols), batch_size):
            batch = self.symbols[i : i + batch_size]
            results = await asyncio.gather(
                *[
                    analyze_symbol(exchange, sym, self.signal_manager, http_session)
                    for sym in batch
                ],
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, Exception):
                    logger.error("Exception dans analyze_symbol : %s", result)
                elif result is not None:
                    signals_this_scan += 1
                    self._signal_count += 1

            # Petite pause entre les batchs
            if i + batch_size < len(self.symbols):
                await asyncio.sleep(0.5)

        if signals_this_scan > 0:
            logger.info(
                "Scan #%d : %d signal(s) émis (total cumulé: %d)",
                self._scan_count,
                signals_this_scan,
                self._signal_count,
            )
        else:
            # Log périodique même sans signal (prouve que Railway voit le bot vivant)
            if self._scan_count % 20 == 0:
                logger.info(
                    "Scan #%d — %d paires analysées | %s UTC",
                    self._scan_count,
                    len(self.symbols),
                    datetime.now(timezone.utc).strftime("%H:%M:%S"),
                )

    def stop(self) -> None:
        self._running = False


# ─── Point d'entrée ───────────────────────────────────────────────────────────

async def _main() -> None:
    bot = TradingBot(symbols=SYMBOLS)

    # Gestion propre de SIGTERM (Railway envoie SIGTERM pour arrêter le worker)
    loop = asyncio.get_running_loop()

    def _handle_stop(signum: int, frame: object) -> None:
        logger.info("Signal %d reçu — arrêt du bot", signum)
        bot.stop()

    for sig in (os_signal.SIGTERM, os_signal.SIGINT):
        try:
            loop.add_signal_handler(sig, lambda s=sig: _handle_stop(s, None))
        except (NotImplementedError, RuntimeError):
            # Windows ne supporte pas add_signal_handler
            pass

    await bot.run()


if __name__ == "__main__":
    asyncio.run(_main())
