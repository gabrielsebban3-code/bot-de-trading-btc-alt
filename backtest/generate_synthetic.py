"""
Générateur de données synthétiques OHLCV réalistes pour tester le moteur de backtest
sans accès réseau. Simule des marchés avec tendances, pullbacks et consolidations.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def generate_ohlcv(
    n: int,
    start_price: float,
    freq: str = "1min",
    start_dt: str = "2024-05-01",
    volatility: float = 0.0008,
    trend_strength: float = 0.0001,
    seed: int = 42,
) -> pd.DataFrame:
    """
    Génère des données OHLCV réalistes avec :
    - Bruit aléatoire (random walk)
    - Tendances directionnelles alternées (haussier/baissier/range)
    - Volumes réalistes corrélés à la volatilité
    """
    np.random.seed(seed)
    timestamps = pd.date_range(start_dt, periods=n, freq=freq, tz="UTC")

    # Simulation du prix de clôture par segments de tendance
    closes = np.zeros(n)
    closes[0] = start_price

    # Créer des phases de marché alternées
    segment_length = n // 6
    phases = (
        [+trend_strength * 2] * segment_length  # fort uptrend
        + [+trend_strength * 0.3] * segment_length  # faible uptrend / pullback
        + [+trend_strength * 1.5] * segment_length  # uptrend reprise
        + [-trend_strength * 2] * segment_length  # downtrend
        + [-trend_strength * 0.3] * segment_length  # faible downtrend / rebond
        + [-trend_strength * 1.5] * (n - 5 * segment_length)  # downtrend reprise
    )

    for i in range(1, n):
        drift = phases[min(i, len(phases) - 1)]
        noise = np.random.normal(0, volatility)
        closes[i] = closes[i - 1] * (1 + drift + noise)

    # Construire OHLCV à partir des closes
    bar_vol = volatility * 2  # amplitude intra-barre

    opens = np.zeros(n)
    highs = np.zeros(n)
    lows = np.zeros(n)

    opens[0] = closes[0] * (1 + np.random.uniform(-bar_vol / 2, bar_vol / 2))
    for i in range(1, n):
        # L'open de la bougie est proche du close précédent (gap limité)
        opens[i] = closes[i - 1] * (1 + np.random.uniform(-bar_vol * 0.3, bar_vol * 0.3))

    for i in range(n):
        body_high = max(opens[i], closes[i])
        body_low = min(opens[i], closes[i])
        # Mèches : extension aléatoire au-delà du corps
        wick_up = abs(np.random.normal(0, bar_vol * closes[i]))
        wick_down = abs(np.random.normal(0, bar_vol * closes[i]))
        highs[i] = body_high + wick_up
        lows[i] = max(body_low - wick_down, closes[i] * 0.95)  # plancher réaliste

    # Volume : corrélé à la volatilité de la bougie
    candle_ranges = (highs - lows) / closes
    base_volume = start_price * 0.5  # volume de base proportionnel au prix
    volumes = base_volume * (1 + candle_ranges * 10 + np.abs(np.random.randn(n) * 0.5))

    return pd.DataFrame({
        "timestamp": timestamps,
        "open": opens,
        "high": highs,
        "low": lows,
        "close": closes,
        "volume": volumes,
    })


def downsample_to_5m(df_1m: pd.DataFrame) -> pd.DataFrame:
    """Convertit des bougies 1m en 5m par agrégation OHLCV standard."""
    df = df_1m.copy()
    df = df.set_index("timestamp")

    resampled = df.resample("5min").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum",
    }).dropna()

    resampled.index.name = "timestamp"
    return resampled.reset_index()


def generate_market_data(
    symbol: str = "BTC/USDT",
    days: int = 30,
    start_price: float = 67000.0,
    seed: int = 42,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Génère 1m + 5m de données synthétiques pour un symbole.
    """
    n_1m = days * 24 * 60  # minutes sur la période
    df_1m = generate_ohlcv(n_1m, start_price, "1min", seed=seed)
    df_5m = downsample_to_5m(df_1m)
    return df_1m, df_5m
