"""
signals.py
==========
Signal-detection logic and confluence scoring.

The entry point is :func:`evaluate_pair`, which receives a dict mapping each
timeframe key (``"1d"``, ``"4h"``, ``"1h"``, ``"15m"``) to its OHLCV
DataFrame and returns a :class:`Signal` (or ``None`` when no high-probability
setup exists).

Scoring (out of 6):
    1. Price taps a directional OB or fills a directional FVG (4H or 1H)
    2. BOS confirmed in the trade direction (1H or 15m)
    3. EMA alignment on 1H
    4. RSI 1H inside the momentum window
    5. Volume spike > 1.5x average on the entry timeframe
    6. >= 3/4 timeframes aligned in the trade direction
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

import pandas as pd

import config
import indicators as ind

Direction = Literal["long", "short"]
_DIR_MAP = {"long": "bullish", "short": "bearish"}


# --------------------------------------------------------------------------- #
# Result containers
# --------------------------------------------------------------------------- #
@dataclass
class Signal:
    pair: str
    direction: Direction
    entry_low: float
    entry_high: float
    stop_loss: float
    take_profits: list[float]
    score: int
    timeframes_ok: dict[str, bool]
    rsi_1h: float
    atr_label: str
    trigger: str
    price: float

    @property
    def entry_mid(self) -> float:
        return (self.entry_low + self.entry_high) / 2.0


# --------------------------------------------------------------------------- #
# Per-timeframe directional bias
# --------------------------------------------------------------------------- #
def timeframe_bias(df: pd.DataFrame) -> Optional[ind.Direction]:
    """
    Combine EMA alignment and the latest structure break into a single bias for
    one timeframe. Returns ``"bullish"`` / ``"bearish"`` / ``None``.
    """
    votes = {"bullish": 0, "bearish": 0}

    ema_dir = ind.ema_alignment(df)
    if ema_dir:
        votes[ema_dir] += 1

    sb = ind.detect_structure_break(df)
    if sb:
        votes[sb.direction] += 1

    if votes["bullish"] > votes["bearish"]:
        return "bullish"
    if votes["bearish"] > votes["bullish"]:
        return "bearish"
    return None


# --------------------------------------------------------------------------- #
# Entry zone + trigger detection
# --------------------------------------------------------------------------- #
def _find_entry_zone(
    df_4h: pd.DataFrame, df_1h: pd.DataFrame, price: float, want: ind.Direction
) -> Optional[tuple[ind.Zone, str]]:
    """
    Find an OB/FVG zone (4H preferred, then 1H) of the desired direction that
    the current price is tapping / filling. Returns (zone, trigger_label).
    """
    for df in (df_4h, df_1h):
        candidates: list[ind.Zone] = []
        candidates += [z for z in ind.find_order_blocks(df) if z.direction == want]
        candidates += [z for z in ind.find_fvgs(df) if z.direction == want]
        # Prefer the most recent zone that price is actually inside.
        candidates.sort(key=lambda z: z.index, reverse=True)
        for z in candidates:
            if z.contains(price):
                return z, z.kind
    return None


# --------------------------------------------------------------------------- #
# SL / TP computation
# --------------------------------------------------------------------------- #
def _compute_sl_tp(
    direction: Direction,
    entry: float,
    ob_zone: ind.Zone,
    df_15m: pd.DataFrame,
    df_4h: pd.DataFrame,
) -> tuple[float, list[float]]:
    """
    SMC-based SL/TP.

    SL : beyond the tapped OB wick (refined on 15m) plus a buffer.
    TPs: scaled by the configured RR multiples and snapped towards real
         structure levels (swing highs/lows, FVGs) when available.
    """
    highs_15, lows_15 = ind.recent_swing_levels(df_15m)
    highs_4h, lows_4h = ind.recent_swing_levels(df_4h)

    if direction == "long":
        # SL below the OB wick low (use the lower of OB low / nearby 15m low).
        wick = ob_zone.low
        if lows_15:
            wick = min(wick, min(lows_15[-3:]))
        sl = wick * (1 - config.SL_BUFFER)
        risk = max(entry - sl, entry * 1e-4)
        tps = [entry + rr * risk for rr in config.TP_RR]
        # Snap TPs upward toward structure highs above entry when present.
        structure = sorted(h for h in (highs_15 + highs_4h) if h > entry)
        tps = _snap_targets(tps, structure, ascending=True)
    else:
        wick = ob_zone.high
        if highs_15:
            wick = max(wick, max(highs_15[-3:]))
        sl = wick * (1 + config.SL_BUFFER)
        risk = max(sl - entry, entry * 1e-4)
        tps = [entry - rr * risk for rr in config.TP_RR]
        structure = sorted((l for l in (lows_15 + lows_4h) if l < entry), reverse=True)
        tps = _snap_targets(tps, structure, ascending=False)

    return sl, tps


def _snap_targets(tps: list[float], levels: list[float], ascending: bool) -> list[float]:
    """
    Nudge each RR target toward the nearest real structure level that lies just
    beyond it, keeping targets monotonic and never reducing the RR.
    """
    if not levels:
        return tps
    snapped: list[float] = []
    for tp in tps:
        beyond = [lvl for lvl in levels if (lvl >= tp if ascending else lvl <= tp)]
        snapped.append(beyond[0] if beyond else tp)
    # Keep monotonic ordering.
    snapped = sorted(snapped, reverse=not ascending)
    return snapped


# --------------------------------------------------------------------------- #
# Main evaluation
# --------------------------------------------------------------------------- #
def evaluate_pair(pair: str, data: dict[str, pd.DataFrame]) -> Optional[Signal]:
    """
    Evaluate one pair across all timeframes. Returns a :class:`Signal` when the
    confluence score meets ``config.MIN_CONFLUENCE_SCORE`` and at least
    ``config.MIN_TIMEFRAMES_ALIGNED`` timeframes agree; otherwise ``None``.
    """
    required = {"1d", "4h", "1h", "15m"}
    if not required.issubset(data) or any(
        data[tf] is None or len(data[tf]) < 50 for tf in required
    ):
        return None

    df_1d, df_4h, df_1h, df_15m = data["1d"], data["4h"], data["1h"], data["15m"]
    price = float(df_1h["close"].iloc[-1])

    # --- Timeframe alignment -------------------------------------------------
    biases = {tf: timeframe_bias(data[tf]) for tf in ("1d", "4h", "1h", "15m")}
    bull_count = sum(1 for b in biases.values() if b == "bullish")
    bear_count = sum(1 for b in biases.values() if b == "bearish")

    if bull_count >= config.MIN_TIMEFRAMES_ALIGNED and bull_count >= bear_count:
        direction: Direction = "long"
    elif bear_count >= config.MIN_TIMEFRAMES_ALIGNED:
        direction = "short"
    else:
        return None

    want = _DIR_MAP[direction]
    aligned = sum(1 for b in biases.values() if b == want)

    # --- Core conditions / scoring ------------------------------------------
    score = 0
    timeframes_ok = {tf: (biases[tf] == want) for tf in ("1d", "4h", "1h", "15m")}

    # (1) OB / FVG tap on 4H or 1H
    zone_hit = _find_entry_zone(df_4h, df_1h, price, want)
    trigger = "—"
    entry_low = entry_high = price
    ob_for_sl: Optional[ind.Zone] = None
    if zone_hit:
        zone, trigger = zone_hit
        entry_low, entry_high = zone.low, zone.high
        ob_for_sl = zone
        score += 1

    # (2) BOS in direction on 1H or 15m
    bos_ok = False
    for df in (df_1h, df_15m):
        sb = ind.detect_structure_break(df)
        if sb and sb.direction == want and sb.type == "BOS":
            bos_ok = True
            break
    if bos_ok:
        score += 1

    # (3) EMA alignment on 1H
    if ind.ema_alignment(df_1h) == want:
        score += 1

    # (4) RSI 1H window
    rsi_series = ind.rsi(df_1h["close"])
    rsi_1h = float(rsi_series.iloc[-1]) if not rsi_series.isna().all() else 0.0
    if direction == "long":
        rsi_ok = config.RSI_LONG_MIN <= rsi_1h <= config.RSI_LONG_MAX
    else:
        rsi_ok = config.RSI_SHORT_MIN <= rsi_1h <= config.RSI_SHORT_MAX
    if rsi_ok:
        score += 1

    # (5) Volume spike on the entry timeframe (1H)
    if ind.volume_spike(df_1h):
        score += 1

    # (6) Timeframe confluence
    if aligned >= config.MIN_TIMEFRAMES_ALIGNED:
        score += 1

    # --- Liquidity sweep upgrades the trigger label when nothing else hit ----
    sweep = ind.detect_liquidity_sweep(df_15m)
    if trigger == "—" and sweep == want:
        trigger = "Liquidity sweep"
    elif sweep == want and zone_hit:
        trigger = f"{trigger} + Liquidity sweep"

    if score < config.MIN_CONFLUENCE_SCORE:
        return None

    # --- SL / TP -------------------------------------------------------------
    # If no OB zone was tapped, fall back to a synthetic zone around the entry
    # using the most recent 15m swing as the protective wick.
    if ob_for_sl is None:
        highs_15, lows_15 = ind.recent_swing_levels(df_15m)
        if want == "bullish":
            low = min(lows_15[-3:]) if lows_15 else price * (1 - 0.005)
            ob_for_sl = ind.Zone(low=low, high=price, direction="bullish", kind="OB", index=len(df_15m) - 1)
        else:
            high = max(highs_15[-3:]) if highs_15 else price * (1 + 0.005)
            ob_for_sl = ind.Zone(low=price, high=high, direction="bearish", kind="OB", index=len(df_15m) - 1)

    sl, tps = _compute_sl_tp(direction, price, ob_for_sl, df_15m, df_4h)
    atr_label, _ = ind.classify_volatility(df_1h)

    return Signal(
        pair=pair,
        direction=direction,
        entry_low=min(entry_low, entry_high),
        entry_high=max(entry_low, entry_high),
        stop_loss=sl,
        take_profits=tps,
        score=score,
        timeframes_ok=timeframes_ok,
        rsi_1h=rsi_1h,
        atr_label=atr_label,
        trigger=trigger,
        price=price,
    )
