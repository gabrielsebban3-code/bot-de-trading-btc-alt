import pandas as pd
from config import EMA_FAST, EMA_MID, EMA_SLOW


def add_emas(df: pd.DataFrame) -> pd.DataFrame:
    """Adds ema_fast, ema_mid, ema_slow columns in-place and returns df."""
    df = df.copy()
    df["ema_fast"] = df["close"].ewm(span=EMA_FAST, adjust=False).mean()
    df["ema_mid"]  = df["close"].ewm(span=EMA_MID,  adjust=False).mean()
    df["ema_slow"] = df["close"].ewm(span=EMA_SLOW, adjust=False).mean()
    return df


def ema_bias(df: pd.DataFrame) -> str:
    """
    Returns 'bullish', 'bearish', or 'neutral' based on the last closed candle.
    """
    last = df.iloc[-2]  # use -2 to skip unclosed candle
    price = last["close"]
    ef, em, es = last["ema_fast"], last["ema_mid"], last["ema_slow"]
    if price > ef > em > es:
        return "bullish"
    if price < ef < em < es:
        return "bearish"
    return "neutral"
