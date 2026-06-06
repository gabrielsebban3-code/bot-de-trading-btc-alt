import pandas as pd
from config import VOLUME_MA_PERIOD, VOLUME_SPIKE_MULT


def add_volume_ma(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["vol_ma"] = df["volume"].rolling(VOLUME_MA_PERIOD).mean()
    return df


def volume_spike(df: pd.DataFrame) -> bool:
    """True if the last closed candle volume is above the spike threshold."""
    last = df.iloc[-2]
    if pd.isna(last["vol_ma"]) or last["vol_ma"] == 0:
        return False
    return last["volume"] > VOLUME_SPIKE_MULT * last["vol_ma"]
