"""
signals.py — Logique de détection des signaux et scoring de confluence.

À partir des analyses par timeframe (produites par indicators.analyze_timeframe),
ce module :
  - détermine le biais directionnel de chaque timeframe
  - compte l'alignement multi-timeframe (au moins 3/4)
  - évalue les 6 conditions LONG / SHORT et calcule un score /6
  - calcule les niveaux d'entrée, SL et 3 TP basés sur la structure SMC
"""

from __future__ import annotations

import config


# ===========================================================================
# BIAIS DIRECTIONNEL PAR TIMEFRAME
# ===========================================================================
def timeframe_bias(analysis: dict) -> str:
    """
    Détermine le biais d'un timeframe ('bullish' / 'bearish' / 'neutral')
    en combinant tendance EMA, BOS et CHOCH.
    """
    votes = {"bullish": 0, "bearish": 0}

    for key in ("ema_trend", "bos", "choch"):
        val = analysis.get(key)
        if val in votes:
            votes[val] += 1

    if votes["bullish"] > votes["bearish"]:
        return "bullish"
    if votes["bearish"] > votes["bullish"]:
        return "bearish"
    return "neutral"


def count_aligned_timeframes(analyses: dict, direction: str) -> tuple[int, dict]:
    """
    Compte combien de timeframes (parmi 1d/4h/1h/15m) sont alignés dans
    `direction`. Retourne (nombre, mapping {tf: bool}).
    """
    aligned = {}
    count = 0
    for tf, analysis in analyses.items():
        ok = timeframe_bias(analysis) == direction
        aligned[tf] = ok
        if ok:
            count += 1
    return count, aligned


# ===========================================================================
# ÉVALUATION DES CONDITIONS (SCORE /6)
# ===========================================================================
def _zone_tapped(analysis_4h: dict, analysis_1h: dict, price: float, direction: str) -> tuple[bool, str]:
    """
    Vérifie si le prix tape un Order Block ou remplit une FVG (4H ou 1H)
    dans la bonne direction. Retourne (touché?, type_de_trigger).
    """
    side = "bullish" if direction == "long" else "bearish"

    for analysis in (analysis_4h, analysis_1h):
        ob = analysis["order_blocks"].get(side)
        if ob and ob["low"] <= price <= ob["high"]:
            return True, "OB"

        fvg = analysis["fvg"].get(side)
        if fvg and fvg["bottom"] <= price <= fvg["top"]:
            return True, "FVG"

    return False, ""


def evaluate(direction: str, analyses: dict) -> dict | None:
    """
    Évalue les 6 conditions pour un signal LONG ou SHORT.

    direction : 'long' ou 'short'
    analyses  : dict {tf: analyse} pour '1d', '4h', '1h', '15m'

    Retourne un dict de signal complet si le score >= MIN_CONFLUENCE_SCORE
    et qu'au moins MIN_TIMEFRAMES_ALIGNED timeframes sont alignés.
    Sinon None.
    """
    a_1h = analyses["1h"]
    a_4h = analyses["4h"]
    a_15m = analyses["15m"]
    price = a_1h["close"]

    bias = "bullish" if direction == "long" else "bearish"

    score = 0
    triggers = []

    # --- Condition 1 : zone OB / FVG tapée (4H ou 1H) ---
    zone_ok, trigger_type = _zone_tapped(a_4h, a_1h, price, direction)
    # Un sweep de liquidité dans le bon sens compte aussi comme déclencheur de zone
    sweep_ok = (
        a_1h["liquidity_sweep"] == bias or a_15m["liquidity_sweep"] == bias
    )
    if zone_ok or sweep_ok:
        score += 1
        if zone_ok:
            triggers.append(trigger_type)
        if sweep_ok:
            triggers.append("Liquidity sweep")

    # --- Condition 2 : BOS confirmé (1H ou 15m) ---
    if a_1h["bos"] == bias or a_15m["bos"] == bias:
        score += 1

    # --- Condition 3 : alignement EMA (1H) ---
    if a_1h["ema_trend"] == bias:
        score += 1

    # --- Condition 4 : RSI (1H) dans la bonne plage ---
    rsi_val = a_1h["rsi"]
    if rsi_val is not None:
        if direction == "long" and config.RSI_LONG_MIN <= rsi_val <= config.RSI_LONG_MAX:
            score += 1
        elif direction == "short" and config.RSI_SHORT_MIN <= rsi_val <= config.RSI_SHORT_MAX:
            score += 1

    # --- Condition 5 : spike de volume (1H) ---
    if a_1h["volume_spike"]:
        score += 1

    # --- Condition 6 : confluence multi-timeframe (>= 3/4) ---
    aligned_count, aligned_map = count_aligned_timeframes(analyses, bias)
    if aligned_count >= config.MIN_TIMEFRAMES_ALIGNED:
        score += 1

    # Bonus de confluence (n'augmente pas le score /6 mais informe l'alerte)
    rsi_div = a_1h["rsi_divergence"] == bias

    # --- Décision ---
    if score < config.MIN_CONFLUENCE_SCORE:
        return None
    if aligned_count < config.MIN_TIMEFRAMES_ALIGNED:
        return None

    levels = calculate_levels(direction, analyses)
    if levels is None:
        return None

    trigger_label = " + ".join(dict.fromkeys(triggers)) if triggers else "OB"

    return {
        "direction": direction,
        "score": score,
        "aligned_count": aligned_count,
        "aligned_map": aligned_map,
        "rsi": rsi_val,
        "rsi_divergence": rsi_div,
        "atr_volatility": a_1h["atr_volatility"],
        "trigger": trigger_label,
        "price": price,
        **levels,
    }


# ===========================================================================
# CALCUL SL / TP (basé SMC)
# ===========================================================================
def calculate_levels(direction: str, analyses: dict) -> dict | None:
    """
    Calcule la zone d'entrée, le Stop Loss et les 3 Take Profits.

    SL : sous (LONG) / au-dessus (SHORT) du wick de l'OB tapé au niveau 15m,
         avec un buffer de 0.2%.
    TP1/TP2/TP3 : structure SMC, sinon fallback sur des RR fixes (1:1.5 / 1:2.5 / 1:4).
    """
    a_1h = analyses["1h"]
    a_4h = analyses["4h"]
    a_15m = analyses["15m"]
    side = "bullish" if direction == "long" else "bearish"
    price = a_1h["close"]

    # --- Zone d'entrée : l'OB ou la FVG tapé(e) ---
    entry_low, entry_high = price, price
    ob_15m = a_15m["order_blocks"].get(side)
    ob_zone = None
    for analysis in (a_15m, a_1h, a_4h):
        ob = analysis["order_blocks"].get(side)
        if ob and ob["low"] <= price <= ob["high"]:
            ob_zone = ob
            entry_low, entry_high = ob["low"], ob["high"]
            break
    if ob_zone is None:
        # fallback : utiliser la FVG
        for analysis in (a_1h, a_4h):
            fvg = analysis["fvg"].get(side)
            if fvg and fvg["bottom"] <= price <= fvg["top"]:
                entry_low, entry_high = fvg["bottom"], fvg["top"]
                break

    # --- Stop Loss basé sur le wick de l'OB 15m (sinon OB tapé) ---
    sl_ob = ob_15m or ob_zone
    if direction == "long":
        wick = sl_ob["low"] if sl_ob else entry_low
        stop_loss = wick * (1 - config.SL_BUFFER)
    else:
        wick = sl_ob["high"] if sl_ob else entry_high
        stop_loss = wick * (1 + config.SL_BUFFER)

    risk = abs(price - stop_loss)
    if risk <= 0:
        return None

    # --- Take Profits ---
    if direction == "long":
        tp1 = price + risk * config.RR_TP1
        tp2 = price + risk * config.RR_TP2
        tp3 = price + risk * config.RR_TP3

        # Affinage via structure SMC si disponible et cohérent
        next_fvg = a_1h["fvg"].get("bearish")
        if next_fvg and next_fvg["bottom"] > price:
            tp1 = max(tp1, next_fvg["bottom"])
        htf_ob = a_4h["order_blocks"].get("bearish")
        if htf_ob and htf_ob["low"] > price:
            tp3 = max(tp3, htf_ob["low"])
    else:
        tp1 = price - risk * config.RR_TP1
        tp2 = price - risk * config.RR_TP2
        tp3 = price - risk * config.RR_TP3

        next_fvg = a_1h["fvg"].get("bullish")
        if next_fvg and next_fvg["top"] < price:
            tp1 = min(tp1, next_fvg["top"])
        htf_ob = a_4h["order_blocks"].get("bullish")
        if htf_ob and htf_ob["high"] < price:
            tp3 = min(tp3, htf_ob["high"])

    def rr(target: float) -> float:
        return round(abs(target - price) / risk, 1)

    return {
        "entry_low": min(entry_low, entry_high),
        "entry_high": max(entry_low, entry_high),
        "stop_loss": stop_loss,
        "tp1": tp1,
        "tp2": tp2,
        "tp3": tp3,
        "rr1": rr(tp1),
        "rr2": rr(tp2),
        "rr3": rr(tp3),
    }


# ===========================================================================
# POINT D'ENTRÉE PRINCIPAL DU MODULE
# ===========================================================================
def detect_signal(analyses: dict) -> dict | None:
    """
    Teste d'abord le LONG puis le SHORT. Retourne le premier signal valide
    rencontré, ou None s'il n'y en a pas.
    """
    for direction in ("long", "short"):
        signal = evaluate(direction, analyses)
        if signal:
            return signal
    return None
