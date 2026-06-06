import pandas as pd
import numpy as np
from config import ATR_PERIOD, ATR_LOW_THRESHOLD, ATR_HIGH_THRESHOLD


def compute_atr(df: pd.DataFrame, period: int = ATR_PERIOD) -> pd.Series:
    high, low, prev_close = df["high"], df["low"], df["close"].shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low  - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["atr"] = compute_atr(df)
    return df


def atr_label(df: pd.DataFrame) -> str:
    last = df.iloc[-2]
    ratio = last["atr"] / last["close"]
    if ratio < ATR_LOW_THRESHOLD:
        return "Low"
    if ratio > ATR_HIGH_THRESHOLD:
        return "High"
    return "Medium"
