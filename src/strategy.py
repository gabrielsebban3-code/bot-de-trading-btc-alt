"""
Module 1 — EMA Trend Rider (multi-timeframe).

Logique :
  • Tendance définie sur 1h : EMA21 vs EMA55 + ADX > seuil.
  • Entrée détectée sur 15m : retracement (pullback) sur l'EMA21 puis rebond
    confirmé par une bougie de clôture dans le sens de la tendance.

Gestion du risque :
  • Stop Loss = ATR(14) * 1.5 sous (LONG) / au-dessus (SHORT) de l'entrée.
  • Take Profit = ratio 2:1 (2x le risque).
"""

import config
from src import reliability


def _trend_direction(row_1h) -> str | None:
    """Renvoie 'LONG', 'SHORT' ou None selon la tendance 1h + filtre ADX."""
    if float(row_1h["adx"]) < config.ADX_MIN:
        return None  # pas de tendance assez forte -> on ne trade pas (anti-range)

    if row_1h["ema_fast"] > row_1h["ema_slow"]:
        return "LONG"
    if row_1h["ema_fast"] < row_1h["ema_slow"]:
        return "SHORT"
    return None


def check(symbol: str, df_1h, df_15m) -> dict | None:
    """
    Analyse un symbole et renvoie un dict de signal, ou None.

    df_1h / df_15m : DataFrames déjà enrichis d'indicateurs.
    """
    if len(df_1h) < config.EMA_SLOW + 5 or len(df_15m) < config.EMA_SLOW + 5:
        return None

    row_1h = df_1h.iloc[-1]
    last = df_15m.iloc[-1]      # dernière bougie 15m clôturée
    prev = df_15m.iloc[-2]

    direction = _trend_direction(row_1h)
    if direction is None:
        return None

    # Les EMA 15m doivent être alignées avec la tendance 1h.
    ema_fast = float(last["ema_fast"])
    ema_slow = float(last["ema_slow"])
    atr = float(last["atr"])
    if atr <= 0:
        return None

    tol = config.PULLBACK_ATR * atr  # zone de tolérance autour de l'EMA21

    if direction == "LONG" and config.ALLOW_LONG:
        aligned = ema_fast > ema_slow
        # Pullback : la mèche basse récente est revenue toucher la zone EMA21.
        pulled_back = min(float(last["low"]), float(prev["low"])) <= ema_fast + tol
        # Rebond confirmé : bougie haussière qui clôture au-dessus de l'EMA21.
        bounce = float(last["close"]) > float(last["open"]) and float(last["close"]) > ema_fast
        if aligned and pulled_back and bounce:
            entry = float(last["close"])
            sl = entry - config.ATR_SL_MULTIPLIER * atr
            tp = entry + config.TP_RR_RATIO * (entry - sl)
            return _build(symbol, "LONG", "TREND", entry, sl, tp,
                          reliability.score_trend("LONG", row_1h, last))

    if direction == "SHORT" and config.ALLOW_SHORT:
        aligned = ema_fast < ema_slow
        # Pullback : la mèche haute récente est remontée toucher la zone EMA21.
        pulled_back = max(float(last["high"]), float(prev["high"])) >= ema_fast - tol
        # Rejet confirmé : bougie baissière qui clôture sous l'EMA21.
        reject = float(last["close"]) < float(last["open"]) and float(last["close"]) < ema_fast
        if aligned and pulled_back and reject:
            entry = float(last["close"])
            sl = entry + config.ATR_SL_MULTIPLIER * atr
            tp = entry - config.TP_RR_RATIO * (sl - entry)
            return _build(symbol, "SHORT", "TREND", entry, sl, tp,
                          reliability.score_trend("SHORT", row_1h, last))

    return None


def _build(symbol, direction, mode, entry, sl, tp, score) -> dict:
    return {
        "symbol": symbol,
        "direction": direction,
        "mode": mode,             # "TREND" ou "CRASH"
        "entry": entry,
        "stop_loss": sl,
        "take_profit": tp,
        "reliability": score,
        "rr": round(abs(tp - entry) / max(abs(entry - sl), 1e-9), 2),
    }
