"""
Orchestrateur : pour chaque symbole, récupère les données, calcule les
indicateurs, puis exécute les deux modules.

Priorité : le module CRASH BOUNCE est testé en premier (il peut override la
tendance baissière). Si pas de crash, on teste le module TREND.
"""

import time
import logging

import config
from src import data_fetcher, indicators, strategy, crash_bounce

logger = logging.getLogger("bot.engine")


def _prepare(symbol: str, interval: str):
    df = data_fetcher.fetch_ohlcv(symbol, interval, config.CANDLES_LIMIT)
    if df is None or len(df) < config.EMA_SLOW + 5:
        return None
    return indicators.enrich(
        df,
        ema_fast=config.EMA_FAST,
        ema_slow=config.EMA_SLOW,
        rsi_period=config.RSI_PERIOD,
        adx_period=config.ADX_PERIOD,
        atr_period=config.ATR_PERIOD,
    )


def analyze_symbol(symbol: str) -> dict | None:
    """Renvoie un signal (dict) pour ce symbole, ou None."""
    df_1h = _prepare(symbol, config.TF_TREND)
    time.sleep(config.REQUEST_SPACING_SEC)
    df_15m = _prepare(symbol, config.TF_ENTRY)

    if df_1h is None or df_15m is None:
        logger.info("%s : données insuffisantes, ignoré.", symbol)
        return None

    # 1) Crash Bounce d'abord (override tendance).
    signal = crash_bounce.check(symbol, df_1h, df_15m)
    if signal is not None:
        signal["candle_time"] = str(df_15m.iloc[-1]["close_time"])
        return signal

    # 2) Sinon, EMA Trend Rider.
    signal = strategy.check(symbol, df_1h, df_15m)
    if signal is not None:
        signal["candle_time"] = str(df_15m.iloc[-1]["close_time"])
        return signal

    return None


def scan_all() -> list[dict]:
    """Analyse tous les symboles configurés et renvoie la liste des signaux."""
    signals = []
    for symbol in config.SYMBOLS:
        try:
            sig = analyze_symbol(symbol)
            if sig is not None:
                score = sig["reliability"]
                if score < config.MIN_RELIABILITY_SCORE:
                    logger.info(
                        "Signal %s %s [%s] ignoré — fiabilité %d%% < minimum %d%%",
                        sig["symbol"], sig["direction"], sig["mode"],
                        score, config.MIN_RELIABILITY_SCORE,
                    )
                else:
                    logger.info(
                        "SIGNAL %s %s [%s] entrée=%s fiab=%d%%",
                        sig["symbol"], sig["direction"], sig["mode"],
                        sig["entry"], score,
                    )
                    signals.append(sig)
        except Exception as exc:  # robustesse : un symbole en erreur ne stoppe pas le scan
            logger.exception("Erreur analyse %s : %s", symbol, exc)
        time.sleep(config.REQUEST_SPACING_SEC)
    return signals
