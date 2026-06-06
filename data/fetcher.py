"""
Fetches OHLCV candles from Binance USDT-M Futures via ccxt.
Returns a pandas DataFrame with columns: timestamp, open, high, low, close, volume.
"""

import time
import logging
import ccxt
import pandas as pd

from config import EXCHANGE_ID, CANDLES_LIMIT

logger = logging.getLogger(__name__)

_exchange: ccxt.Exchange | None = None


def get_exchange() -> ccxt.Exchange:
    global _exchange
    if _exchange is None:
        _exchange = getattr(ccxt, EXCHANGE_ID)({"enableRateLimit": True})
        _exchange.load_markets()
    return _exchange


def fetch_ohlcv(symbol: str, timeframe: str, limit: int = CANDLES_LIMIT) -> pd.DataFrame:
    """
    Returns a DataFrame of OHLCV candles, newest candle last.
    Retries up to 3 times on network errors.
    """
    ex = get_exchange()
    for attempt in range(3):
        try:
            raw = ex.fetch_ohlcv(symbol, timeframe, limit=limit)
            df = pd.DataFrame(raw, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
            df = df.set_index("timestamp")
            return df
        except ccxt.NetworkError as e:
            if attempt == 2:
                raise
            logger.warning("Network error fetching %s %s (attempt %d): %s", symbol, timeframe, attempt + 1, e)
            time.sleep(2 ** attempt)
    raise RuntimeError("Unreachable")


def fetch_all_timeframes(symbol: str, timeframes: list[str]) -> dict[str, pd.DataFrame]:
    """Returns {timeframe: DataFrame} for each requested timeframe."""
    return {tf: fetch_ohlcv(symbol, tf) for tf in timeframes}
