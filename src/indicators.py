"""
Indicateurs techniques calculés manuellement (pandas/numpy).

On évite les librairies externes type pandas_ta pour rester 100% robuste
et autonome (pas de soucis de compatibilité numpy/pandas sur Railway).

Toutes les fonctions prennent un DataFrame avec les colonnes :
open, high, low, close, volume.
"""

import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    """Moyenne mobile exponentielle (EMA)."""
    return series.ewm(span=period, adjust=False).mean()


def _wilder_rma(series: pd.Series, period: int) -> pd.Series:
    """Moyenne mobile lissée de Wilder (RMA), utilisée par RSI/ATR/ADX."""
    return series.ewm(alpha=1.0 / period, adjust=False).mean()


def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    """RSI de Wilder."""
    delta = series.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = _wilder_rma(gain, period)
    avg_loss = _wilder_rma(loss, period)
    rs = avg_gain / avg_loss.replace(0.0, 1e-12)
    return 100.0 - (100.0 / (1.0 + rs))


def true_range(df: pd.DataFrame) -> pd.Series:
    """True Range = max(h-l, |h-c_prev|, |l-c_prev|)."""
    high = df["high"]
    low = df["low"]
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            (high - low),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Average True Range (lissage de Wilder)."""
    return _wilder_rma(true_range(df), period)


def adx(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    """
    ADX complet avec +DI et -DI (méthode de Wilder).

    Retourne un DataFrame avec les colonnes : adx, plus_di, minus_di.
    """
    high = df["high"]
    low = df["low"]

    up_move = high.diff()
    down_move = -low.diff()

    plus_dm = ((up_move > down_move) & (up_move > 0)) * up_move
    minus_dm = ((down_move > up_move) & (down_move > 0)) * down_move

    tr = true_range(df)
    atr_w = _wilder_rma(tr, period).replace(0.0, 1e-12)

    plus_di = 100.0 * _wilder_rma(plus_dm, period) / atr_w
    minus_di = 100.0 * _wilder_rma(minus_dm, period) / atr_w

    di_sum = (plus_di + minus_di).replace(0.0, 1e-12)
    dx = 100.0 * (plus_di - minus_di).abs() / di_sum
    adx_line = _wilder_rma(dx, period)

    return pd.DataFrame(
        {
            "adx": adx_line,
            "plus_di": plus_di,
            "minus_di": minus_di,
        }
    )


def enrich(df: pd.DataFrame, ema_fast: int, ema_slow: int,
           rsi_period: int, adx_period: int, atr_period: int) -> pd.DataFrame:
    """
    Ajoute toutes les colonnes d'indicateurs au DataFrame et le renvoie.

    Colonnes ajoutées : ema_fast, ema_slow, rsi, atr, adx, plus_di, minus_di,
    vol_ma (moyenne mobile du volume sur 20).
    """
    out = df.copy()
    out["ema_fast"] = ema(out["close"], ema_fast)
    out["ema_slow"] = ema(out["close"], ema_slow)
    out["rsi"] = rsi(out["close"], rsi_period)
    out["atr"] = atr(out, atr_period)

    adx_df = adx(out, adx_period)
    out["adx"] = adx_df["adx"]
    out["plus_di"] = adx_df["plus_di"]
    out["minus_di"] = adx_df["minus_di"]

    out["vol_ma"] = out["volume"].rolling(window=20, min_periods=1).mean()
    return out
