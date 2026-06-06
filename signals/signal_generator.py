"""
Main signal generation pipeline for a single symbol.
Returns a Signal dataclass or None if no valid signal.
"""

from __future__ import annotations
from dataclasses import dataclass, field
import logging

import pandas as pd

from config import TIMEFRAMES, MIN_TF_CONFLUENCE
from data.fetcher import fetch_all_timeframes
from indicators.ema import add_emas, ema_bias
from indicators.rsi import add_rsi, rsi_bias, rsi_value, detect_rsi_divergence
from indicators.atr import add_atr, atr_label
from indicators.volume import add_volume_ma, volume_spike
from smc.order_blocks import find_order_blocks, nearest_touched_ob
from smc.fvg import find_fvgs, nearest_touched_fvg
from smc.bos_choch import detect_bos
from smc.liquidity import detect_liquidity_sweep
from signals.confluence import timeframe_bias, count_aligned_timeframes
from signals.sl_tp import compute_levels, Levels

logger = logging.getLogger(__name__)


@dataclass
class Signal:
    symbol: str
    direction: str           # 'long' or 'short'
    levels: Levels
    confluence_score: int    # out of 6
    tf_biases: dict[str, str]
    rsi_1h: float
    rsi_divergence: str
    atr_label: str
    trigger: str             # 'OB' | 'FVG' | 'Liquidity sweep'


def _prepare(df: pd.DataFrame) -> pd.DataFrame:
    df = add_emas(df)
    df = add_rsi(df)
    df = add_atr(df)
    df = add_volume_ma(df)
    return df


def generate_signal(symbol: str) -> Signal | None:
    try:
        candles = fetch_all_timeframes(symbol, TIMEFRAMES)
    except Exception as e:
        logger.error("Failed to fetch candles for %s: %s", symbol, e)
        return None

    prepared: dict[str, pd.DataFrame] = {tf: _prepare(df) for tf, df in candles.items()}

    # ── Multi-timeframe bias ───────────────────────────────────────────────────
    tf_biases = {tf: timeframe_bias(df) for tf, df in prepared.items()}

    bull_tfs = count_aligned_timeframes(tf_biases, "bullish")
    bear_tfs = count_aligned_timeframes(tf_biases, "bearish")

    if bull_tfs >= MIN_TF_CONFLUENCE:
        direction = "long"
        aligned_tfs = bull_tfs
    elif bear_tfs >= MIN_TF_CONFLUENCE:
        direction = "short"
        aligned_tfs = bear_tfs
    else:
        return None

    # ── Use 1H as reference for individual condition checks ───────────────────
    df_1h = prepared["1h"]
    price = float(df_1h["close"].iloc[-2])

    # Condition 1 – EMA alignment on 1H
    cond_ema = ema_bias(df_1h) == ("bullish" if direction == "long" else "bearish")

    # Condition 2 – RSI on 1H in range
    cond_rsi = rsi_bias(df_1h) == ("bullish" if direction == "long" else "bearish")

    # Condition 3 – Volume spike on 1H
    cond_vol = volume_spike(df_1h)

    # Condition 4 – BOS on 1H or 15m
    bos_1h  = detect_bos(df_1h)
    bos_15m = detect_bos(prepared["15m"])
    if direction == "long":
        cond_bos = bos_1h["bullish_bos"] or bos_15m["bullish_bos"]
    else:
        cond_bos = bos_1h["bearish_bos"] or bos_15m["bearish_bos"]

    # Condition 5 – OB or FVG touched on 4H or 1H
    df_4h   = prepared["4h"]
    price_4h = float(df_4h["close"].iloc[-2])

    ob_dir = "bullish" if direction == "long" else "bearish"

    ob_4h  = nearest_touched_ob(price_4h, find_order_blocks(df_4h), ob_dir)
    ob_1h  = nearest_touched_ob(price,    find_order_blocks(df_1h), ob_dir)
    fvg_4h = nearest_touched_fvg(price_4h, find_fvgs(df_4h), ob_dir)
    fvg_1h = nearest_touched_fvg(price,    find_fvgs(df_1h), ob_dir)

    active_ob  = ob_1h or ob_4h
    active_fvg = fvg_1h or fvg_4h

    # Condition 6 – Liquidity sweep on 1H
    liq = detect_liquidity_sweep(df_1h)
    liq_key = "bullish_sweep" if direction == "long" else "bearish_sweep"
    cond_liq = liq[liq_key]

    cond_smc = bool(active_ob or active_fvg or cond_liq)

    # Require OB/FVG/sweep AND BOS AND EMA AND RSI AND Volume
    if not (cond_smc and cond_bos and cond_ema and cond_rsi and cond_vol):
        return None

    # ── Confluence score (6 criteria) ─────────────────────────────────────────
    score = sum([cond_ema, cond_rsi, cond_vol, cond_bos, cond_smc, aligned_tfs >= MIN_TF_CONFLUENCE])

    # ── Determine trigger label ────────────────────────────────────────────────
    if active_ob:
        trigger = "OB"
    elif active_fvg:
        trigger = "FVG"
    else:
        trigger = "Liquidity sweep"

    # ── SL / TP ───────────────────────────────────────────────────────────────
    levels = compute_levels(direction, price, active_ob, active_fvg)

    rsi_val = rsi_value(df_1h)
    rsi_div = detect_rsi_divergence(df_1h)
    atr_lbl = atr_label(df_1h)

    return Signal(
        symbol=symbol,
        direction=direction,
        levels=levels,
        confluence_score=score,
        tf_biases=tf_biases,
        rsi_1h=rsi_val,
        rsi_divergence=rsi_div,
        atr_label=atr_lbl,
        trigger=trigger,
    )
