"""
discord_alert.py — Construction et envoi des alertes Discord (webhook embed).

Format de l'embed conforme à la spécification, avec couleurs :
  - vert (#00b347) pour les LONG
  - rouge (#e74c3c) pour les SHORT
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

import requests

logger = logging.getLogger(__name__)

WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

COLOR_LONG = 0x00B347   # vert
COLOR_SHORT = 0xE74C3C  # rouge


def _pct(value: float, reference: float) -> float:
    """Variation en % de `value` par rapport à `reference`."""
    if reference == 0:
        return 0.0
    return (value - reference) / reference * 100


def _fmt(price: float) -> str:
    """Formate un prix avec une précision adaptée à sa grandeur."""
    if price >= 100:
        return f"${price:,.2f}"
    if price >= 1:
        return f"${price:,.4f}"
    return f"${price:,.6f}"


def build_embed(pair: str, signal: dict) -> dict:
    """Construit le dict embed Discord à partir d'un signal."""
    direction = signal["direction"]
    is_long = direction == "long"
    price = signal["price"]

    emoji = "🟢" if is_long else "🔴"
    label = "LONG" if is_long else "SHORT"
    color = COLOR_LONG if is_long else COLOR_SHORT

    sl = signal["stop_loss"]
    tp1, tp2, tp3 = signal["tp1"], signal["tp2"], signal["tp3"]

    aligned = signal["aligned_map"]

    def tf_mark(tf: str) -> str:
        return "✅" if aligned.get(tf) else "❌"

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    description = (
        f"📍 **Entry zone** : {_fmt(signal['entry_low'])} – {_fmt(signal['entry_high'])}\n"
        f"🛑 **Stop Loss**  : {_fmt(sl)}  ({_pct(sl, price):+.2f}%)\n"
        f"🎯 **TP1**        : {_fmt(tp1)}  ({_pct(tp1, price):+.2f}%) — RR 1:{signal['rr1']}\n"
        f"🎯 **TP2**        : {_fmt(tp2)}  ({_pct(tp2, price):+.2f}%) — RR 1:{signal['rr2']}\n"
        f"🎯 **TP3**        : {_fmt(tp3)}  ({_pct(tp3, price):+.2f}%) — RR 1:{signal['rr3']}\n\n"
        f"📊 **Confluence score** : {signal['score']}/6\n"
        f"⏱ **Timeframes OK**    : "
        f"1D {tf_mark('1d')} | 4H {tf_mark('4h')} | 1H {tf_mark('1h')} | 15m {tf_mark('15m')}\n"
        f"📈 **RSI (1H)**        : {signal['rsi']:.1f}\n"
        f"⚡ **Volatilité ATR**  : {signal['atr_volatility']}\n"
        f"🧱 **Trigger**         : {signal['trigger']}"
    )
    if signal.get("rsi_divergence"):
        description += "\n🔀 **Divergence RSI** : confirmée"

    return {
        "title": f"{emoji} {label} SIGNAL — {pair}",
        "description": description,
        "color": color,
        "footer": {"text": f"⏰ {timestamp}"},
    }


def send_alert(pair: str, signal: dict) -> bool:
    """
    Envoie l'alerte vers le webhook Discord.
    Retourne True si l'envoi a réussi, False sinon (sans jamais lever).
    """
    if not WEBHOOK_URL:
        logger.error("DISCORD_WEBHOOK_URL non défini — alerte non envoyée.")
        return False

    embed = build_embed(pair, signal)
    payload = {"embeds": [embed]}

    try:
        resp = requests.post(WEBHOOK_URL, json=payload, timeout=15)
        if resp.status_code in (200, 204):
            return True
        logger.error(
            "Échec webhook Discord (%s) : %s", resp.status_code, resp.text[:200]
        )
        return False
    except requests.RequestException as exc:
        logger.error("Erreur lors de l'envoi Discord : %s", exc)
        return False
