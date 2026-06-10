"""
Indicateurs techniques + détection des pivots (Swing Highs / Swing Lows).
Toutes les fonctions sont pures — aucun effet de bord.
"""
import numpy as np
import pandas as pd

ATR_PERIOD = 14
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9
RSI_PERIOD = 14
VOLUME_AVG_PERIOD = 20


# ─── EMA ──────────────────────────────────────────────────────────────────────

def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


# ─── ATR ──────────────────────────────────────────────────────────────────────

def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / ATR_PERIOD, adjust=False).mean()
    return df


# ─── Volume moyen ─────────────────────────────────────────────────────────────

def add_volume_avg(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["volume_avg"] = df["volume"].rolling(VOLUME_AVG_PERIOD).mean()
    return df


# ─── VWAP (reset quotidien) ───────────────────────────────────────────────────

def add_vwap(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["_date"] = df["timestamp"].dt.normalize()
    df["_tp"] = (df["high"] + df["low"] + df["close"]) / 3
    df["_tpv"] = df["_tp"] * df["volume"]
    df["_cum_tpv"] = df.groupby("_date")["_tpv"].cumsum()
    df["_cum_vol"] = df.groupby("_date")["volume"].cumsum()
    df["vwap"] = df["_cum_tpv"] / df["_cum_vol"]
    df.drop(columns=["_date", "_tp", "_tpv", "_cum_tpv", "_cum_vol"], inplace=True)
    return df


# ─── Swing Highs / Swing Lows ─────────────────────────────────────────────────

def find_swing_highs(df: pd.DataFrame, lookback: int) -> pd.Series:
    """
    Retourne une Series booléenne : True où le high est le plus haut
    dans la fenêtre centrée [i-lookback, i+lookback].
    Les `lookback` premières et dernières barres sont toujours False
    (fenêtre incomplète → pas de confirmation → pas de lookahead).
    """
    highs = df["high"]
    win = 2 * lookback + 1
    rolling_max = highs.rolling(window=win, center=True, min_periods=win).max()
    is_sh = highs == rolling_max
    is_sh.iloc[:lookback] = False
    is_sh.iloc[-lookback:] = False
    return is_sh


def find_swing_lows(df: pd.DataFrame, lookback: int) -> pd.Series:
    """
    Retourne une Series booléenne : True où le low est le plus bas
    dans la fenêtre centrée [i-lookback, i+lookback].
    """
    lows = df["low"]
    win = 2 * lookback + 1
    rolling_min = lows.rolling(window=win, center=True, min_periods=win).min()
    is_sl = lows == rolling_min
    is_sl.iloc[:lookback] = False
    is_sl.iloc[-lookback:] = False
    return is_sl


# ─── Point d'entrée unique ────────────────────────────────────────────────────

def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """Applique ATR + volume_avg + VWAP. Suffisant pour la stratégie MSS."""
    df = add_atr(df)
    df = add_volume_avg(df)
    df = add_vwap(df)
    return df
