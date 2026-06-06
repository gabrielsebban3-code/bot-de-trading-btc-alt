"""
Formatage et envoi des alertes Discord via webhook.
Embed coloré avec toutes les informations du signal SMC.
"""

import os
import json
import logging
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

from config import TP1_RR, TP2_RR, TP3_RR

load_dotenv()

logger = logging.getLogger(__name__)

# URL du webhook Discord (injectée via Railway env vars)
DISCORD_WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL", "")

# Couleurs embed
COLOR_LONG = 0x00B347   # vert
COLOR_SHORT = 0xE74C3C  # rouge


def _format_price(price: float) -> str:
    """Formate un prix avec séparateurs de milliers et 2 décimales."""
    if price >= 1000:
        return f"${price:,.2f}"
    if price >= 1:
        return f"${price:.4f}"
    return f"${price:.6f}"


def _tf_status(biases: dict) -> str:
    """
    Construit la ligne des timeframes avec ✅ ou ❌ selon le biais.
    Ex : "1D ✅ | 4H ✅ | 1H ✅ | 15m ❌"
    """
    mapping = {
        "1d": "1D",
        "4h": "4H",
        "1h": "1H",
        "15m": "15m",
    }
    direction = None
    # Détecter la direction dominante
    bullish_count = sum(1 for v in biases.values() if v == "bullish")
    bearish_count = sum(1 for v in biases.values() if v == "bearish")
    direction = "bullish" if bullish_count >= bearish_count else "bearish"

    parts = []
    for tf_key, tf_label in mapping.items():
        bias = biases.get(tf_key, "neutral")
        ok = "✅" if bias == direction else "❌"
        parts.append(f"{tf_label} {ok}")
    return " | ".join(parts)


def build_embed(signal: dict) -> dict:
    """
    Construit le payload d'un embed Discord à partir d'un signal.

    signal dict attendu :
      pair, direction, entry_zone_low, entry_zone_high,
      sl, sl_pct, tp1, tp1_pct, tp2, tp2_pct, tp3, tp3_pct,
      confluence_score, tf_biases, rsi, atr_label, trigger
    """
    is_long = signal["direction"] == "long"
    emoji = "🟢" if is_long else "🔴"
    direction_label = "LONG SIGNAL" if is_long else "SHORT SIGNAL"
    color = COLOR_LONG if is_long else COLOR_SHORT

    pair = signal["pair"]
    entry_low = _format_price(signal["entry_zone_low"])
    entry_high = _format_price(signal["entry_zone_high"])

    sl = _format_price(signal["sl"])
    sl_pct = f"{signal['sl_pct']:.2f}%"

    tp1 = _format_price(signal["tp1"])
    tp1_pct = f"{signal['tp1_pct']:.2f}%"
    tp2 = _format_price(signal["tp2"])
    tp2_pct = f"{signal['tp2_pct']:.2f}%"
    tp3 = _format_price(signal["tp3"])
    tp3_pct = f"{signal['tp3_pct']:.2f}%"

    sign = "+" if is_long else "-"
    sl_sign = "-" if is_long else "+"

    tf_line = _tf_status(signal["tf_biases"])
    timestamp_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    description = (
        f"📍 **Entry zone** : {entry_low} – {entry_high}\n"
        f"🛑 **Stop Loss**  : {sl}  ({sl_sign}{sl_pct})\n"
        f"🎯 **TP1**        : {tp1}  ({sign}{tp1_pct}) — RR 1:{TP1_RR}\n"
        f"🎯 **TP2**        : {tp2}  ({sign}{tp2_pct}) — RR 1:{TP2_RR}\n"
        f"🎯 **TP3**        : {tp3}  ({sign}{tp3_pct}) — RR 1:{TP3_RR}\n"
        f"\n"
        f"📊 **Confluence score** : {signal['confluence_score']}/6\n"
        f"⏱ **Timeframes OK**    : {tf_line}\n"
        f"📈 **RSI (1H)**         : {signal['rsi']}\n"
        f"⚡ **Volatilité ATR**   : {signal['atr_label']}\n"
        f"🧱 **Trigger**          : {signal['trigger']}\n"
        f"\n"
        f"⏰ {timestamp_utc}"
    )

    embed = {
        "title": f"{emoji} {direction_label} — {pair}",
        "description": description,
        "color": color,
    }

    return {"embeds": [embed]}


def send_signal(signal: dict) -> bool:
    """
    Envoie un signal formaté sur Discord via webhook.

    Retourne True si l'envoi a réussi, False sinon.
    """
    if not DISCORD_WEBHOOK_URL:
        logger.error("DISCORD_WEBHOOK_URL non configurée — signal non envoyé")
        return False

    payload = build_embed(signal)

    try:
        response = requests.post(
            DISCORD_WEBHOOK_URL,
            data=json.dumps(payload),
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        if response.status_code in (200, 204):
            logger.info(f"✅ Signal envoyé sur Discord : {signal['pair']} {signal['direction'].upper()}")
            return True
        else:
            logger.error(
                f"Erreur Discord webhook — status {response.status_code} : {response.text}"
            )
            return False
    except requests.exceptions.RequestException as e:
        logger.error(f"Erreur réseau lors de l'envoi Discord : {e}")
        return False


def send_startup_message(pair_count: int) -> None:
    """Envoie un message de démarrage du bot sur Discord."""
    if not DISCORD_WEBHOOK_URL:
        return

    timestamp_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    payload = {
        "embeds": [
            {
                "title": "🤖 Bot SMC Trading démarré",
                "description": (
                    f"✅ Bot opérationnel — **{pair_count} paires** surveillées\n"
                    f"📡 Scan toutes les **15 minutes**\n"
                    f"⏰ {timestamp_utc}"
                ),
                "color": 0x3498DB,
            }
        ]
    }

    try:
        requests.post(
            DISCORD_WEBHOOK_URL,
            data=json.dumps(payload),
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
    except Exception as e:
        logger.warning(f"Impossible d'envoyer le message de démarrage Discord : {e}")
