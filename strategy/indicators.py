"""
Calcul de tous les indicateurs techniques utilisés par la stratégie.
Chaque fonction prend un DataFrame OHLCV et retourne une Series ou le DataFrame enrichi.
Aucune dépendance vers le reste du projet — pur calcul.
"""
import numpy as np
import pandas as pd
from strategy.config import (
    ATR_PERIOD,
    EMA_FAST,
    EMA_MID,
    EMA_SLOW,
    MACD_FAST,
    MACD_SIGNAL,
    MACD_SLOW,
    RSI_PERIOD,
    VOLUME_AVG_PERIOD,
)


# ─── EMA ──────────────────────────────────────────────────────────────────────

def ema(series: pd.Series, period: int) -> pd.Series:
    """EMA classique via pandas ewm (ajust=False = méthode Wilder)."""
    return series.ewm(span=period, adjust=False).mean()


def add_emas(df: pd.DataFrame) -> pd.DataFrame:
    """Ajoute ema9, ema21, ema50 en colonnes."""
    df = df.copy()
    df["ema9"] = ema(df["close"], EMA_FAST)
    df["ema21"] = ema(df["close"], EMA_MID)
    df["ema50"] = ema(df["close"], EMA_SLOW)
    return df


# ─── VWAP (reset quotidien) ───────────────────────────────────────────────────

def add_vwap(df: pd.DataFrame) -> pd.DataFrame:
    """
    VWAP avec reset à chaque nouvelle journée UTC.
    Nécessite une colonne 'timestamp' (datetime64 UTC).
    """
    df = df.copy()
    # Clé de groupe = date UTC de la bougie
    df["_date"] = df["timestamp"].dt.normalize()
    df["_tp"] = (df["high"] + df["low"] + df["close"]) / 3  # typical price
    df["_tpv"] = df["_tp"] * df["volume"]

    # Cumul intra-journalier par groupe de date
    df["_cum_tpv"] = df.groupby("_date")["_tpv"].cumsum()
    df["_cum_vol"] = df.groupby("_date")["volume"].cumsum()

    df["vwap"] = df["_cum_tpv"] / df["_cum_vol"]

    # Nettoyage des colonnes temporaires
    df.drop(columns=["_date", "_tp", "_tpv", "_cum_tpv", "_cum_vol"], inplace=True)
    return df


# ─── RSI ──────────────────────────────────────────────────────────────────────

def add_rsi(df: pd.DataFrame) -> pd.DataFrame:
    """RSI 14 de Wilder via ewm."""
    df = df.copy()
    delta = df["close"].diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / RSI_PERIOD, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / RSI_PERIOD, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    df["rsi"] = 100 - (100 / (1 + rs))
    return df


# ─── MACD ─────────────────────────────────────────────────────────────────────

def add_macd(df: pd.DataFrame) -> pd.DataFrame:
    """MACD standard (12,26,9). Ajoute macd_line, macd_signal, macd_hist."""
    df = df.copy()
    fast = ema(df["close"], MACD_FAST)
    slow = ema(df["close"], MACD_SLOW)
    df["macd_line"] = fast - slow
    df["macd_signal"] = ema(df["macd_line"], MACD_SIGNAL)
    df["macd_hist"] = df["macd_line"] - df["macd_signal"]
    return df


# ─── ATR ──────────────────────────────────────────────────────────────────────

def add_atr(df: pd.DataFrame) -> pd.DataFrame:
    """ATR 14 de Wilder."""
    df = df.copy()
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    df["atr"] = tr.ewm(alpha=1 / ATR_PERIOD, adjust=False).mean()
    return df


# ─── Volume moyen ─────────────────────────────────────────────────────────────

def add_volume_avg(df: pd.DataFrame) -> pd.DataFrame:
    """Rolling mean du volume sur VOLUME_AVG_PERIOD bougies."""
    df = df.copy()
    df["volume_avg"] = df["volume"].rolling(VOLUME_AVG_PERIOD).mean()
    return df


# ─── Point d'entrée unique ────────────────────────────────────────────────────

def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """
    Applique tous les indicateurs en séquence.
    Le DataFrame doit avoir les colonnes : timestamp, open, high, low, close, volume.
    """
    df = add_emas(df)
    df = add_vwap(df)
    df = add_rsi(df)
    df = add_macd(df)
    df = add_atr(df)
    df = add_volume_avg(df)
    return df
