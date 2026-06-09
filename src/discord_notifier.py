"""
Envoi des alertes vers Discord via webhook (embeds riches et colorés).
"""

import logging

import requests

import config
from src.utils import fmt_price

logger = logging.getLogger("bot.discord")

# Couleurs des embeds (décimal).
_COLOR_LONG = 0x2ECC71   # vert
_COLOR_SHORT = 0xE74C3C  # rouge
_COLOR_CRASH = 0xF39C12  # orange


def _pair_label(symbol: str) -> str:
    """BTCUSDT -> BTC/USDT."""
    if symbol.endswith("USDT"):
        return f"{symbol[:-4]}/USDT"
    return symbol


def send_signal(signal: dict) -> bool:
    """Envoie une alerte de signal. Renvoie True si Discord a accepté (HTTP 2xx)."""
    if not config.DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL non configurée — alerte non envoyée.")
        return False

    pair = _pair_label(signal["symbol"])
    direction = signal["direction"]
    is_crash = signal["mode"] == "CRASH"

    if is_crash:
        color = _COLOR_CRASH
        title = f"⚡ CRASH BOUNCE — {pair} LONG"
    else:
        color = _COLOR_LONG if direction == "LONG" else _COLOR_SHORT
        arrow = "📈" if direction == "LONG" else "📉"
        title = f"{arrow} {pair} — {direction}"

    fields = [
        {"name": "💰 Entrée", "value": f"`{fmt_price(signal['entry'])}`", "inline": True},
        {"name": "🛑 Stop Loss", "value": f"`{fmt_price(signal['stop_loss'])}`", "inline": True},
        {"name": "🎯 Take Profit", "value": f"`{fmt_price(signal['take_profit'])}`", "inline": True},
        {"name": "📊 Fiabilité", "value": f"**{signal['reliability']}%**", "inline": True},
        {"name": "⚖️ Risk/Reward", "value": f"`{signal['rr']}:1`", "inline": True},
    ]

    if is_crash:
        fields.append({
            "name": "📉 Chute détectée",
            "value": f"`{signal['drop_pct'] * 100:.1f}%` · volume `x{signal['vol_ratio']:.1f}`",
            "inline": True,
        })

    embed = {
        "title": title,
        "color": color,
        "fields": fields,
        "footer": {"text": "Bot Intraday"},
    }

    payload = {"embeds": [embed]}
    return _post(payload)


def send_text(message: str) -> bool:
    """Envoie un simple message texte (ex: démarrage du bot)."""
    if not config.DISCORD_WEBHOOK_URL:
        logger.warning("DISCORD_WEBHOOK_URL non configurée — message non envoyé.")
        return False
    return _post({"content": message})


def _post(payload: dict, max_retries: int = 3) -> bool:
    delay = 2.0
    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.post(config.DISCORD_WEBHOOK_URL, json=payload, timeout=15)
            # Discord renvoie 204 No Content en cas de succès.
            if resp.status_code in (200, 204):
                return True
            if resp.status_code == 429:  # rate limit
                retry_after = float(resp.json().get("retry_after", delay))
                logger.warning("Discord rate-limit, attente %.1fs", retry_after)
                import time
                time.sleep(retry_after)
                continue
            logger.warning("Discord a répondu %s : %s", resp.status_code, resp.text[:200])
        except requests.RequestException as exc:
            logger.warning("Echec envoi Discord (tentative %d/%d) : %s", attempt, max_retries, exc)
        if attempt < max_retries:
            import time
            time.sleep(delay)
            delay *= 2
    return False
