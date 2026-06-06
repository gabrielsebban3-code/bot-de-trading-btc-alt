"""
Moteur de génération de signaux SMC multi-timeframe.
Combine tous les indicateurs pour produire des signaux LONG / SHORT avec SL/TP automatiques.
"""

import pandas as pd

from config import (
    MIN_CONFLUENCE_SCORE, MIN_TF_ALIGNED,
    SL_BUFFER, TP1_RR, TP2_RR, TP3_RR,
)
from indicators import (
    calculate_emas, calculate_rsi, calculate_atr,
    ema_trend_direction, rsi_signal,
    volume_spike, atr_volatility_label,
    detect_order_blocks, detect_fvg, detect_bos_choch, detect_liquidity_sweep,
    price_in_order_block, price_in_fvg, get_tf_bias,
)


def _count_tf_alignment(biases: dict, direction: str) -> int:
    """Compte combien de timeframes sont alignés dans la direction donnée."""
    return sum(1 for bias in biases.values() if bias == direction)


def _calculate_sl_tp(direction: str, entry_price: float, ob_level: float, atr_val: float) -> dict:
    """
    Calcule Stop Loss et 3 niveaux de Take Profit basés sur le RR.

    Pour LONG  : SL = low de l'OB - buffer
    Pour SHORT : SL = high de l'OB + buffer
    TP calculés à partir du risk (entry - SL).
    """
    if direction == "long":
        sl = ob_level * (1 - SL_BUFFER)
        risk = entry_price - sl
        if risk <= 0:
            # Fallback sur ATR si l'OB est incohérent
            risk = atr_val if atr_val > 0 else entry_price * 0.01
            sl = entry_price - risk
        tp1 = entry_price + risk * TP1_RR
        tp2 = entry_price + risk * TP2_RR
        tp3 = entry_price + risk * TP3_RR
    else:  # short
        sl = ob_level * (1 + SL_BUFFER)
        risk = sl - entry_price
        if risk <= 0:
            risk = atr_val if atr_val > 0 else entry_price * 0.01
            sl = entry_price + risk
        tp1 = entry_price - risk * TP1_RR
        tp2 = entry_price - risk * TP2_RR
        tp3 = entry_price - risk * TP3_RR

    sl_pct = abs(entry_price - sl) / entry_price * 100
    tp1_pct = abs(tp1 - entry_price) / entry_price * 100
    tp2_pct = abs(tp2 - entry_price) / entry_price * 100
    tp3_pct = abs(tp3 - entry_price) / entry_price * 100

    return {
        "sl": sl,
        "sl_pct": sl_pct,
        "tp1": tp1,
        "tp1_pct": tp1_pct,
        "tp2": tp2,
        "tp2_pct": tp2_pct,
        "tp3": tp3,
        "tp3_pct": tp3_pct,
        "risk": risk,
    }


def analyze_pair(pair: str, candles: dict) -> dict | None:
    """
    Analyse complète d'une paire sur les 4 timeframes.

    candles : dict {timeframe: pd.DataFrame} avec colonnes
              [open, high, low, close, volume]

    Retourne un dict signal ou None si aucun signal valide.
    """
    required_tfs = ["1d", "4h", "1h", "15m"]

    # Vérifier que tous les timeframes sont disponibles
    for tf in required_tfs:
        if tf not in candles or candles[tf] is None or len(candles[tf]) < 50:
            return None

    # ── Calculer les indicateurs sur chaque TF ──────────────────────────────
    dfs = {}
    for tf in required_tfs:
        df = candles[tf].copy()
        df = calculate_emas(df)
        df = calculate_rsi(df)
        df = calculate_atr(df)
        dfs[tf] = df

    # ── Biais directionnels par TF ───────────────────────────────────────────
    # df_has_emas=True : les EMAs sont déjà calculées ci-dessus, évite le double calcul
    biases = {}
    for tf in required_tfs:
        biases[tf] = get_tf_bias(dfs[tf], df_has_emas=True)

    tf_bullish_count = _count_tf_alignment(biases, "bullish")
    tf_bearish_count = _count_tf_alignment(biases, "bearish")

    # Pas assez de TF alignés dans aucune direction → pas de signal
    if tf_bullish_count < MIN_TF_ALIGNED and tf_bearish_count < MIN_TF_ALIGNED:
        return None

    # ── Indicateurs sur 1H (TF de référence pour les conditions d'entrée) ───
    df_1h = dfs["1h"]
    df_4h = dfs["4h"]
    df_15m = dfs["15m"]

    current_price = df_1h["close"].iloc[-1]
    ema_dir_1h = ema_trend_direction(df_1h)
    rsi_dir = rsi_signal(df_1h)
    rsi_val = df_1h["rsi"].iloc[-1]
    vol_spike = volume_spike(df_1h)
    atr_label = atr_volatility_label(df_1h)
    atr_val = df_1h["atr"].iloc[-1]

    # ── SMC sur 4H et 1H ────────────────────────────────────────────────────
    ob_4h = detect_order_blocks(df_4h)
    ob_1h = detect_order_blocks(df_1h)
    fvg_4h = detect_fvg(df_4h)
    fvg_1h = detect_fvg(df_1h)
    bos_1h = detect_bos_choch(df_1h)
    bos_15m = detect_bos_choch(df_15m)
    sweep_1h = detect_liquidity_sweep(df_1h)

    # ── Évaluation LONG ──────────────────────────────────────────────────────
    if tf_bullish_count >= MIN_TF_ALIGNED:
        score = 0
        trigger = None
        ob_sl_level = current_price  # niveau de référence pour le SL

        # Condition 1 : Price tape un Bullish OB ou remplit un Bullish FVG (4H ou 1H)
        in_ob_4h = price_in_order_block(current_price, ob_4h["bullish_ob"])
        in_ob_1h = price_in_order_block(current_price, ob_1h["bullish_ob"])
        in_fvg_4h = price_in_fvg(current_price, fvg_4h["bullish_fvg"])
        in_fvg_1h = price_in_fvg(current_price, fvg_1h["bullish_fvg"])

        if in_ob_4h or in_ob_1h:
            score += 1
            trigger = "OB"
            ob_ref = ob_4h["bullish_ob"] if in_ob_4h else ob_1h["bullish_ob"]
            ob_sl_level = ob_ref["low"]
        elif in_fvg_4h or in_fvg_1h:
            score += 1
            trigger = "FVG"
            fvg_ref = fvg_4h["bullish_fvg"] if in_fvg_4h else fvg_1h["bullish_fvg"]
            ob_sl_level = fvg_ref["low"]

        # Condition 2 : BOS bullish confirmé sur 1H ou 15m
        if bos_1h["bos_bullish"] or bos_15m["bos_bullish"]:
            score += 1

        # Condition 3 : EMA alignées bullish sur 1H
        if ema_dir_1h == "bullish":
            score += 1

        # Condition 4 : RSI 1H entre 40–65
        if rsi_dir == "long":
            score += 1

        # Condition 5 : Volume spike
        if vol_spike:
            score += 1

        # Condition 6 : Liquidity sweep bullish
        if sweep_1h["bullish_sweep"]:
            score += 1
            if trigger is None:
                trigger = "Liquidity sweep"

        if score >= MIN_CONFLUENCE_SCORE and trigger is not None:
            sl_tp = _calculate_sl_tp("long", current_price, ob_sl_level, atr_val)
            return {
                "pair": pair,
                "direction": "long",
                "entry_price": current_price,
                "entry_zone_low": current_price * 0.999,
                "entry_zone_high": current_price * 1.001,
                "confluence_score": score,
                "tf_aligned": tf_bullish_count,
                "tf_biases": biases,
                "rsi": round(rsi_val, 1),
                "atr_label": atr_label,
                "trigger": trigger,
                **sl_tp,
            }

    # ── Évaluation SHORT ─────────────────────────────────────────────────────
    if tf_bearish_count >= MIN_TF_ALIGNED:
        score = 0
        trigger = None
        ob_sl_level = current_price

        # Condition 1 : Price tape un Bearish OB ou remplit un Bearish FVG (4H ou 1H)
        in_ob_4h = price_in_order_block(current_price, ob_4h["bearish_ob"])
        in_ob_1h = price_in_order_block(current_price, ob_1h["bearish_ob"])
        in_fvg_4h = price_in_fvg(current_price, fvg_4h["bearish_fvg"])
        in_fvg_1h = price_in_fvg(current_price, fvg_1h["bearish_fvg"])

        if in_ob_4h or in_ob_1h:
            score += 1
            trigger = "OB"
            ob_ref = ob_4h["bearish_ob"] if in_ob_4h else ob_1h["bearish_ob"]
            ob_sl_level = ob_ref["high"]
        elif in_fvg_4h or in_fvg_1h:
            score += 1
            trigger = "FVG"
            fvg_ref = fvg_4h["bearish_fvg"] if in_fvg_4h else fvg_1h["bearish_fvg"]
            ob_sl_level = fvg_ref["high"]

        # Condition 2 : BOS bearish confirmé sur 1H ou 15m
        if bos_1h["bos_bearish"] or bos_15m["bos_bearish"]:
            score += 1

        # Condition 3 : EMA alignées bearish sur 1H
        if ema_dir_1h == "bearish":
            score += 1

        # Condition 4 : RSI 1H entre 35–60
        if rsi_dir == "short":
            score += 1

        # Condition 5 : Volume spike
        if vol_spike:
            score += 1

        # Condition 6 : Liquidity sweep bearish
        if sweep_1h["bearish_sweep"]:
            score += 1
            if trigger is None:
                trigger = "Liquidity sweep"

        if score >= MIN_CONFLUENCE_SCORE and trigger is not None:
            sl_tp = _calculate_sl_tp("short", current_price, ob_sl_level, atr_val)
            return {
                "pair": pair,
                "direction": "short",
                "entry_price": current_price,
                "entry_zone_low": current_price * 0.999,
                "entry_zone_high": current_price * 1.001,
                "confluence_score": score,
                "tf_aligned": tf_bearish_count,
                "tf_biases": biases,
                "rsi": round(rsi_val, 1),
                "atr_label": atr_label,
                "trigger": trigger,
                **sl_tp,
            }

    return None
