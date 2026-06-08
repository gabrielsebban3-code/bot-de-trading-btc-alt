"""
Envoi des signaux vers Discord via webhook.
Format embed propre et lisible, couleurs LONG/SHORT, tous les champs utiles.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

import aiohttp

from strategy.strategy import Signal

logger = logging.getLogger(__name__)

# Couleurs Discord (format décimal)
COLOR_LONG = 0x4CAF50   # vert
COLOR_SHORT = 0xF44336  # rouge
COLOR_ERROR = 0xFF9800  # orange


def _format_price(price: float) -> str:
    """Formate le prix selon son amplitude (évite les 0.000001)."""
    if price >= 1000:
        return f"{price:,.2f}"
    if price >= 1:
        return f"{price:.4f}"
    return f"{price:.6f}"


def _build_embed(signal: Signal) -> dict:
    """Construit le payload embed Discord pour un signal."""
    is_long = signal.side == "LONG"
    color = COLOR_LONG if is_long else COLOR_SHORT
    emoji = "🟢" if is_long else "🔴"
    direction = "LONG ▲" if is_long else "SHORT ▼"

    # Barre de score visuelle (10 segments)
    filled = round(signal.score / 10)
    score_bar = "█" * filled + "░" * (10 - filled)

    ind = signal.indicators
    atr_pct = ind.atr_5m / signal.entry * 100

    fields = [
        {"name": "📥 Entrée",  "value": f"`{_format_price(signal.entry)}`",  "inline": True},
        {"name": "🛑 Stop-Loss", "value": f"`{_format_price(signal.sl)}`",  "inline": True},
        {"name": "⚖️ R:R",     "value": f"`{signal.rr:.2f}:1`",             "inline": True},
        {"name": "🎯 TP1 (1R)", "value": f"`{_format_price(signal.tp1)}`",  "inline": True},
        {"name": "🎯 TP2 (2R)", "value": f"`{_format_price(signal.tp2)}`",  "inline": True},
        {"name": "📊 Score",    "value": f"`{score_bar}` {signal.score}/100", "inline": True},
        # Séparateur + indicateurs
        {
            "name": "📈 Indicateurs 5m",
            "value": (
                f"EMA9 `{_format_price(ind.ema9_5m)}` | "
                f"EMA21 `{_format_price(ind.ema21_5m)}` | "
                f"EMA50 `{_format_price(ind.ema50_5m)}`\n"
                f"VWAP `{_format_price(ind.vwap_5m)}` | "
                f"ATR `{ind.atr_5m:.4f}` ({atr_pct:.2f}%)"
            ),
            "inline": False,
        },
        {
            "name": "⚡ Déclencheur 1m",
            "value": (
                f"RSI `{ind.rsi_1m:.1f}` | "
                f"MACD hist `{ind.macd_hist_1m:+.6f}` | "
                f"Volume `{ind.volume_ratio:.2f}×`"
            ),
            "inline": False,
        },
    ]

    ts_iso = signal.timestamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "embeds": [
            {
                "title": f"{emoji} {signal.symbol} — {direction}",
                "color": color,
                "fields": fields,
                "footer": {
                    "text": f"Biais: {signal.timeframe_bias} | Entrée: {signal.timeframe_entry} | "
                            f"⚠️ Analyse uniquement, pas un conseil financier",
                },
                "timestamp": ts_iso,
            }
        ]
    }


async def send_signal(webhook_url: str, signal: Signal, session: aiohttp.ClientSession) -> bool:
    """
    Envoie un signal Discord via webhook.
    Retourne True si succès, False sinon.
    """
    if not webhook_url:
        logger.warning("DISCORD_WEBHOOK_URL non configuré — signal non envoyé")
        return False

    payload = _build_embed(signal)

    try:
        async with session.post(
            webhook_url,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=10),
        ) as resp:
            if resp.status in (200, 204):
                logger.info("Signal Discord envoyé : %s %s score=%d", signal.symbol, signal.side, signal.score)
                return True
            text = await resp.text()
            logger.warning("Discord webhook erreur %d : %s", resp.status, text[:200])
            return False
    except Exception as e:
        logger.error("Impossible d'envoyer le signal Discord : %s", e)
        return False


async def send_startup_message(webhook_url: str, session: aiohttp.ClientSession, symbols: list[str]) -> None:
    """Message de démarrage du bot."""
    if not webhook_url:
        return

    payload = {
        "embeds": [
            {
                "title": "🚀 Bot Trend-Pullback Scalper démarré",
                "color": 0x2196F3,
                "fields": [
                    {"name": "Paires surveillées", "value": ", ".join(symbols), "inline": False},
                    {
                        "name": "Avertissement",
                        "value": "Ce bot émet des **signaux d'analyse uniquement**. "
                                 "Ce ne sont pas des conseils financiers.",
                        "inline": False,
                    },
                ],
                "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        ]
    }

    try:
        async with session.post(webhook_url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status not in (200, 204):
                logger.warning("Message de démarrage Discord : erreur %d", resp.status)
    except Exception as e:
        logger.warning("Impossible d'envoyer le message de démarrage : %s", e)
