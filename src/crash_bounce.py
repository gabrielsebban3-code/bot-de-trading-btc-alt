"""
Module 2 — Crash Bounce Detector ("wick hunter").

Objectif : détecter un crash violent (type 2 février 2026) et acheter le
rebond au fond de la mèche, MÊME si la tendance 1h est baissière (override).

Conditions de détection (sur 15m) :
  • Chute >= 5% sur 3 bougies (CRASH_DROP_PCT / CRASH_LOOKBACK).
  • RSI en capitulation (< 25).
  • Spike de volume (>= 3x la moyenne).
  • Longue mèche basse sur la bougie du creux (rejet des bas prix).
  • Bougie de confirmation haussière clôturant au-dessus de 50% du range du creux.

Gestion du risque :
  • Stop Loss = sous le low de la mèche (- buffer ATR).
  • Take Profit = retracement 50% de la chute (mi-chemin vers le haut d'avant crash).
"""

import config
from src import reliability


def check(symbol: str, df_1h, df_15m) -> dict | None:
    if not config.CRASH_ENABLED:
        return None

    n = config.CRASH_LOOKBACK
    if len(df_15m) < max(n + 3, config.CRASH_VOLUME_MA + 2):
        return None

    confirm = df_15m.iloc[-1]        # bougie de confirmation (dernière clôturée)
    bottom = df_15m.iloc[-2]         # bougie du creux (potentielle mèche)

    # --- 1) Détection de la chute sur la fenêtre menant au creux ---
    # close juste avant la fenêtre de chute vs low du creux.
    pre_crash_close = float(df_15m.iloc[-2 - n]["close"])
    drop_pct = (float(bottom["low"]) - pre_crash_close) / pre_crash_close
    if drop_pct > config.CRASH_DROP_PCT:  # ex: -0.03 > -0.05 -> pas assez de chute
        return None

    # --- 2) RSI en capitulation au creux ---
    rsi_low = float(bottom["rsi"])
    if rsi_low > config.CRASH_RSI_MAX:
        return None

    # --- 3) Spike de volume sur le creux ---
    vol_ma = max(float(bottom["vol_ma"]), 1e-9)
    vol_ratio = float(bottom["volume"]) / vol_ma
    if vol_ratio < config.CRASH_VOLUME_SPIKE:
        return None

    # --- 4) Longue mèche basse sur le creux (rejet des bas) ---
    rng = float(bottom["high"]) - float(bottom["low"])
    if rng <= 0:
        return None
    lower_wick = min(float(bottom["open"]), float(bottom["close"])) - float(bottom["low"])
    wick_ratio = lower_wick / rng
    if wick_ratio < config.CRASH_WICK_MIN_RATIO:
        return None

    # --- 5) Bougie de confirmation : haussière, clôture > 50% du range du creux ---
    mid_level = float(bottom["low"]) + config.CRASH_CONFIRM_MID * rng
    is_bullish = float(confirm["close"]) > float(confirm["open"])
    closes_above_mid = float(confirm["close"]) > mid_level
    if not (is_bullish and closes_above_mid):
        return None

    # --- Construction du signal ---
    entry = float(confirm["close"])
    atr = float(confirm["atr"])
    sl = float(bottom["low"]) - config.CRASH_SL_ATR_BUFFER * atr
    # TP = retracement 50% de la chute : mi-chemin entre le low et le close pré-crash.
    tp = float(bottom["low"]) + 0.5 * (pre_crash_close - float(bottom["low"]))

    # Sécurité : le TP doit être au-dessus de l'entrée et le SL en dessous.
    if not (sl < entry < tp):
        return None

    # Filtre risk/reward : on n'alerte pas un rebond au ratio défavorable.
    rr = (tp - entry) / max(entry - sl, 1e-9)
    if rr < config.CRASH_MIN_RR:
        return None

    confirm_range = max(float(confirm["high"]) - float(confirm["low"]), 1e-9)
    confirm_strength = (float(confirm["close"]) - float(confirm["open"])) / confirm_range

    score = reliability.score_crash(drop_pct, rsi_low, vol_ratio, wick_ratio, confirm_strength)

    return {
        "symbol": symbol,
        "direction": "LONG",
        "mode": "CRASH",
        "entry": entry,
        "stop_loss": sl,
        "take_profit": tp,
        "reliability": score,
        "rr": round(rr, 2),
        "drop_pct": drop_pct,         # info supplémentaire pour l'alerte
        "vol_ratio": vol_ratio,
    }
