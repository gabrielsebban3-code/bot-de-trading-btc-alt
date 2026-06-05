"""
discord_alert.py
================
Build and send the Discord webhook embed for a trading signal.

The embed mirrors the spec layout exactly and uses raw ``httpx`` POSTs to the
webhook URL (no extra Discord dependency required). Failures are logged and
swallowed so the scan loop never crashes.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

import httpx

import config
from signals import Signal

logger = logging.getLogger("bot.discord")

COLOR_LONG = 0x00B347   # green
COLOR_SHORT = 0xE74C3C  # red


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #
def _fmt_price(value: float) -> str:
    """Format a price with sensible precision for both large and tiny assets."""
    if value >= 100:
        return f"${value:,.2f}"
    if value >= 1:
        return f"${value:,.4f}"
    return f"${value:,.6f}"


def _pct(target: float, ref: float) -> float:
    if ref == 0:
        return 0.0
    return (target - ref) / ref * 100.0


def _rr(direction: str, entry: float, sl: float, tp: float) -> float:
    risk = abs(entry - sl)
    if risk == 0:
        return 0.0
    reward = abs(tp - entry)
    return reward / risk


def build_description(sig: Signal) -> str:
    """Build the human-readable embed description block."""
    entry = sig.entry_mid
    sign = "+" if sig.direction == "long" else "-"

    lines = [
        f"📍 **Entry zone** : {_fmt_price(sig.entry_low)} – {_fmt_price(sig.entry_high)}",
        f"🛑 **Stop Loss**  : {_fmt_price(sig.stop_loss)}  ({_pct(sig.stop_loss, entry):+.2f}%)",
    ]
    for i, tp in enumerate(sig.take_profits, start=1):
        rr = _rr(sig.direction, entry, sig.stop_loss, tp)
        lines.append(
            f"🎯 **TP{i}**        : {_fmt_price(tp)}  ({_pct(tp, entry):+.2f}%) — RR 1:{rr:.1f}"
        )

    tf_order = ["1d", "4h", "1h", "15m"]
    tf_labels = {"1d": "1D", "4h": "4H", "1h": "1H", "15m": "15m"}
    tf_str = " | ".join(
        f"{tf_labels[tf]} {'✅' if sig.timeframes_ok.get(tf) else '❌'}" for tf in tf_order
    )

    lines += [
        "",
        f"📊 **Confluence score** : {sig.score}/6",
        f"⏱ **Timeframes OK**    : {tf_str}",
        f"📈 **RSI (1H)**        : {sig.rsi_1h:.1f}",
        f"⚡ **Volatilité ATR**  : {sig.atr_label}",
        f"🧱 **Trigger**         : {sig.trigger}",
    ]
    return "\n".join(lines)


def build_embed(sig: Signal) -> dict:
    """Build the full Discord embed payload for a signal."""
    is_long = sig.direction == "long"
    emoji = "🟢" if is_long else "🔴"
    label = "LONG" if is_long else "SHORT"
    color = COLOR_LONG if is_long else COLOR_SHORT
    now = datetime.now(timezone.utc)

    embed = {
        "title": f"{emoji} {label} SIGNAL — {sig.pair}",
        "description": build_description(sig),
        "color": color,
        "footer": {"text": f"⏰ {now.strftime('%Y-%m-%d %H:%M:%S')} UTC"},
        "timestamp": now.isoformat(),
    }
    return {"embeds": [embed]}


# --------------------------------------------------------------------------- #
# Sending
# --------------------------------------------------------------------------- #
def send_signal(sig: Signal, webhook_url: str | None = None) -> bool:
    """
    POST the signal embed to the Discord webhook.

    Returns True on success. Never raises — errors are logged and ``False`` is
    returned so the caller can carry on scanning.
    """
    url = webhook_url or config.DISCORD_WEBHOOK_URL
    if not url:
        logger.error("DISCORD_WEBHOOK_URL is not configured; skipping alert.")
        return False

    payload = build_embed(sig)
    try:
        resp = httpx.post(url, json=payload, timeout=15.0)
        if resp.status_code in (200, 204):
            return True
        logger.error("Discord webhook returned %s: %s", resp.status_code, resp.text[:200])
        return False
    except httpx.HTTPError as exc:
        logger.error("Discord webhook request failed: %s", exc)
        return False
