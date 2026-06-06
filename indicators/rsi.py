import pandas as pd
import numpy as np
from config import RSI_PERIOD, RSI_LONG_MIN, RSI_LONG_MAX, RSI_SHORT_MIN, RSI_SHORT_MAX


def compute_rsi(series: pd.Series, period: int = RSI_PERIOD) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def add_rsi(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["rsi"] = compute_rsi(df["close"])
    return df


def rsi_bias(df: pd.DataFrame) -> str:
    """Returns 'bullish', 'bearish', or 'neutral' based on RSI range."""
    rsi_val = df["rsi"].iloc[-2]
    if RSI_LONG_MIN <= rsi_val <= RSI_LONG_MAX:
        return "bullish"
    if RSI_SHORT_MIN <= rsi_val <= RSI_SHORT_MAX:
        return "bearish"
    return "neutral"


def rsi_value(df: pd.DataFrame) -> float:
    return float(df["rsi"].iloc[-2])


def detect_rsi_divergence(df: pd.DataFrame, lookback: int = 20) -> str:
    """
    Simple divergence: compare the last two swing highs/lows in price vs RSI.
    Returns 'bullish_div', 'bearish_div', or 'none'.
    """
    closes = df["close"].iloc[-lookback:-1].values
    rsi_vals = df["rsi"].iloc[-lookback:-1].values

    # Bullish divergence: price makes lower low, RSI makes higher low
    price_lows_idx = [i for i in range(1, len(closes) - 1)
                      if closes[i] < closes[i - 1] and closes[i] < closes[i + 1]]
    if len(price_lows_idx) >= 2:
        i1, i2 = price_lows_idx[-2], price_lows_idx[-1]
        if closes[i2] < closes[i1] and rsi_vals[i2] > rsi_vals[i1]:
            return "bullish_div"

    # Bearish divergence: price makes higher high, RSI makes lower high
    price_highs_idx = [i for i in range(1, len(closes) - 1)
                       if closes[i] > closes[i - 1] and closes[i] > closes[i + 1]]
    if len(price_highs_idx) >= 2:
        i1, i2 = price_highs_idx[-2], price_highs_idx[-1]
        if closes[i2] > closes[i1] and rsi_vals[i2] < rsi_vals[i1]:
            return "bearish_div"

    return "none"
