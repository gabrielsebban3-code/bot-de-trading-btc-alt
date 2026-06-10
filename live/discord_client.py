"""
Embeds Discord pour la stratégie Liquidity Sweep + MSS.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import aiohttp

from strategy.strategy import Signal

logger = logging.getLogger(__name__)

COLOR_LONG  = 0x4CAF50
COLOR_SHORT = 0xF44336


def _fp(price: float) -> str:
    if price >= 1000:
        return f"{price:,.2f}"
    if price >= 1:
        return f"{price:.4f}"
    return f"{price:.6f}"


def _build_embed(signal: Signal) -> dict:
    is_long = signal.side == "LONG"
    color = COLOR_LONG if is_long else COLOR_SHORT
    emoji = "🟢" if is_long else "🔴"
    direction = "LONG — Bullish Sweep + MSS ▲" if is_long else "SHORT — Bearish Sweep + MSS ▼"

    filled = round(signal.score / 10)
    score_bar = "█" * filled + "░" * (10 - filled)
    ind = signal.indicators

    fields = [
        {
            "name": "📍 Zone OTE — ENTRÉE LIMITE",
            "value": f"Entre `{_fp(signal.ote_lower)}` et `{_fp(signal.ote_upper)}`",
            "inline": False,
        },
        {"name": "✅ Entrée suggérée", "value": f"`{_fp(signal.entry)}`", "inline": True},
        {"name": "🛑 Stop-Loss",       "value": f"`{_fp(signal.sl)}`",    "inline": True},
        {"name": "⚖️ R:R",             "value": f"`{signal.rr:.1f}:1`",  "inline": True},
        {"name": "🎯 TP1 (2R)",        "value": f"`{_fp(signal.tp1)}`",  "inline": True},
        {"name": "🎯 TP2 (3R)",        "value": f"`{_fp(signal.tp2)}`",  "inline": True},
        {"name": "📊 Score",           "value": f"`{score_bar}` {signal.score}/100", "inline": True},
        {
            "name": "🔍 Structure",
            "value": (
                f"Swing balayé : `{_fp(ind.sweep_level)}`\n"
                f"Mèche extrême : `{_fp(ind.sweep_wick)}`\n"
                f"Cassure MSS : `{_fp(ind.mss_level)}`"
            ),
            "inline": False,
        },
        {
            "name": "📐 Fibonacci",
            "value": (
                f"Ancre basse `{_fp(ind.fib_low)}` → Ancre haute `{_fp(ind.fib_high)}`\n"
                f"61.8% : `{_fp(ind.fib_618)}` | 78.6% : `{_fp(ind.fib_786)}`"
            ),
            "inline": False,
        },
        {
            "name": "⚡ Volume & ATR",
            "value": f"Sweep `{ind.sweep_vol_ratio:.2f}×` | MSS `{ind.mss_vol_ratio:.2f}×` | ATR `{ind.atr:.4f}`",
            "inline": False,
        },
    ]

    ts_iso = signal.timestamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "embeds": [{
            "title": f"{emoji} {signal.symbol} — {direction}",
            "color": color,
            "fields": fields,
            "footer": {"text": "Sweep+MSS 1m | ⚠️ Analyse uniquement — pas un conseil financier"},
            "timestamp": ts_iso,
        }]
    }


async def send_signal(webhook_url: str, signal: Signal, session: aiohttp.ClientSession) -> bool:
    if not webhook_url:
        logger.warning("DISCORD_WEBHOOK_URL non configuré")
        return False
    try:
        async with session.post(
            webhook_url,
            json=_build_embed(signal),
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status in (200, 204):
                logger.info("Signal Discord : %s %s score=%d", signal.symbol, signal.side, signal.score)
                return True
            logger.warning("Discord erreur %d : %s", resp.status, (await resp.text())[:200])
            return False
    except Exception as e:
        logger.error("Envoi Discord échoué : %s", e)
        return False


async def send_startup_message(webhook_url: str, session: aiohttp.ClientSession, symbols: list[str]) -> None:
    if not webhook_url:
        return
    payload = {
        "embeds": [{
            "title": "🚀 Bot Liquidity Sweep + MSS démarré",
            "color": 0x2196F3,
            "fields": [
                {"name": "Paires", "value": ", ".join(symbols), "inline": False},
                {"name": "Stratégie", "value": "Liquidity Sweep + Market Structure Shift (MSS) | Zone OTE Fibonacci", "inline": False},
                {"name": "⚠️ Avertissement", "value": "Signaux d'analyse uniquement — pas des conseils financiers.", "inline": False},
            ],
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }]
    }
    try:
        async with session.post(webhook_url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status not in (200, 204):
                logger.warning("Startup Discord : erreur %d", resp.status)
    except Exception as e:
        logger.warning("Startup Discord échoué : %s", e)
