"""
Score de fiabilité (%) affiché dans les alertes.

⚠️ IMPORTANT : ce score est une CONFIANCE HEURISTIQUE, pas un taux de
réussite garanti ni backtesté. Il agrège la qualité des conditions au
moment du signal (force de la tendance, alignement multi-timeframe,
position du RSI, confirmation par le volume, force de la bougie).

Plus les conditions s'empilent dans le bon sens, plus le % est élevé.
Le résultat est borné pour rester réaliste (jamais 100%).
"""

import config


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def score_trend(direction: str, row_1h, row_15m) -> int:
    """
    Score pour un signal du module EMA Trend Rider.

    direction : "LONG" ou "SHORT"
    row_1h / row_15m : dernières bougies (Series pandas) avec indicateurs.
    """
    score = 45.0  # base

    # 1) Force de la tendance via ADX 1h (de ADX_MIN à ~50 -> bonus jusqu'à +22)
    adx_1h = float(row_1h["adx"])
    score += _clamp((adx_1h - config.ADX_MIN) / (50.0 - config.ADX_MIN), 0, 1) * 22.0

    # 2) ADX 15m aligné (bonus jusqu'à +8)
    adx_15m = float(row_15m["adx"])
    score += _clamp((adx_15m - 20.0) / 30.0, 0, 1) * 8.0

    # 3) Alignement directionnel +DI / -DI (bonus +10)
    if direction == "LONG" and row_1h["plus_di"] > row_1h["minus_di"]:
        score += 10.0
    if direction == "SHORT" and row_1h["minus_di"] > row_1h["plus_di"]:
        score += 10.0

    # 4) RSI dans une zone saine (momentum sans surextension) (bonus jusqu'à +8)
    rsi_15m = float(row_15m["rsi"])
    if direction == "LONG":
        # idéal entre 45 et 65
        score += (1.0 - _clamp(abs(rsi_15m - 55.0) / 35.0, 0, 1)) * 8.0
    else:
        # idéal entre 35 et 55
        score += (1.0 - _clamp(abs(rsi_15m - 45.0) / 35.0, 0, 1)) * 8.0

    # 5) Volume au-dessus de la moyenne (bonus jusqu'à +7)
    vol_ratio = float(row_15m["volume"]) / max(float(row_15m["vol_ma"]), 1e-9)
    score += _clamp((vol_ratio - 1.0) / 1.5, 0, 1) * 7.0

    return int(_clamp(score, 50, 92))


def score_crash(drop_pct: float, rsi_low: float, vol_ratio: float,
                wick_ratio: float, confirm_strength: float) -> int:
    """
    Score pour un signal du module Crash Bounce.

    drop_pct : ampleur de la chute (négatif, ex -0.07)
    rsi_low : RSI au creux (plus bas = plus survendu)
    vol_ratio : volume du crash / moyenne
    wick_ratio : taille de la mèche basse / range de la bougie
    confirm_strength : force de la bougie de confirmation (corps/range)
    """
    score = 45.0

    # Ampleur de la chute (de -5% à -15% -> +18)
    score += _clamp((abs(drop_pct) - 0.05) / 0.10, 0, 1) * 18.0

    # Profondeur du RSI (25 -> 0 pts ; 10 -> +12)
    score += _clamp((config.CRASH_RSI_MAX - rsi_low) / 15.0, 0, 1) * 12.0

    # Spike de volume (3x -> base ; 8x -> +12)
    score += _clamp((vol_ratio - config.CRASH_VOLUME_SPIKE) / 5.0, 0, 1) * 12.0

    # Rejet de la mèche basse (40% -> base ; 80% -> +8)
    score += _clamp((wick_ratio - config.CRASH_WICK_MIN_RATIO) / 0.40, 0, 1) * 8.0

    # Force de la bougie de confirmation (+5)
    score += _clamp(confirm_strength, 0, 1) * 5.0

    return int(_clamp(score, 50, 90))
