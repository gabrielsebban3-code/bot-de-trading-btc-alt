"""
Sends a formatted Discord embed for a trading signal.
Reads DISCORD_WEBHOOK_URL from the environment (.env file).
"""

import os
import logging
from datetime import datetime, timezone

import requests

from signals.signal_generator import Signal

logger = logging.getLogger(__name__)

COLOR_LONG  = 0x00B347
COLOR_SHORT = 0xE74C3C


def _pct(entry: float, target: float) -> str:
    return f"{(target - entry) / entry * 100:+.2f}%"


def _rr(entry: float, sl: float, tp: float) -> str:
    risk   = abs(entry - sl)
    reward = abs(tp - entry)
    if risk == 0:
        return "N/A"
    return f"1:{reward / risk:.1f}"


def send_signal(signal: Signal) -> bool:
    url = os.getenv("DISCORD_WEBHOOK_URL")
    if not url:
        logger.error("DISCORD_WEBHOOK_URL not set — cannot send alert.")
        return False

    lvl   = signal.levels
    entry = (lvl.entry_low + lvl.entry_high) / 2
    sl    = lvl.sl

    dir_emoji = "🟢" if signal.direction == "long" else "🔴"
    dir_label = "LONG" if signal.direction == "long" else "SHORT"
    color     = COLOR_LONG if signal.direction == "long" else COLOR_SHORT

    # Timeframe status line
    tf_labels = {"1d": "1D", "4h": "4H", "1h": "1H", "15m": "15m"}
    tf_line = " | ".join(
        f"{tf_labels[tf]} {'✅' if b == signal.direction.replace('long','bullish').replace('short','bearish') else '❌'}"
        for tf, b in signal.tf_biases.items()
    )

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    description = (
        f"**📍 Entry zone :** `${lvl.entry_low:,.2f} – ${lvl.entry_high:,.2f}`\n"
        f"**🛑 Stop Loss  :** `${sl:,.2f}`  ({_pct(entry, sl)})\n"
        f"**🎯 TP1        :** `${lvl.tp1:,.2f}`  ({_pct(entry, lvl.tp1)}) — RR {_rr(entry, sl, lvl.tp1)}\n"
        f"**🎯 TP2        :** `${lvl.tp2:,.2f}`  ({_pct(entry, lvl.tp2)}) — RR {_rr(entry, sl, lvl.tp2)}\n"
        f"**🎯 TP3        :** `${lvl.tp3:,.2f}`  ({_pct(entry, lvl.tp3)}) — RR {_rr(entry, sl, lvl.tp3)}\n"
        f"\n"
        f"**📊 Confluence score :** {signal.confluence_score}/6\n"
        f"**⏱ Timeframes OK    :** {tf_line}\n"
        f"**📈 RSI (1H)        :** {signal.rsi_1h:.1f}"
        + (f"  _{signal.rsi_divergence.replace('_', ' ')}_" if signal.rsi_divergence != "none" else "")
        + f"\n"
        f"**⚡ Volatilité ATR  :** {signal.atr_label}\n"
        f"**🧱 Trigger         :** {signal.trigger}\n"
        f"\n"
        f"⏰ {now_utc}"
    )

    payload = {
        "embeds": [
            {
                "title": f"{dir_emoji} {dir_label} SIGNAL — {signal.symbol}",
                "description": description,
                "color": color,
            }
        ]
    }

    try:
        resp = requests.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        logger.info("Discord alert sent for %s %s", signal.symbol, signal.direction)
        return True
    except requests.RequestException as e:
        logger.error("Failed to send Discord alert: %s", e)
        return False
