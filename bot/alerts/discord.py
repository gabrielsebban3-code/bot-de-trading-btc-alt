"""Discord alerts (Step 9). The webhook URL is a secret (DISCORD_WEBHOOK_URL in bot/.env or the environment).

* One embed per new signal: pair, direction, concept, timeframe, entry, initial stop, exit rule, estimated R:R,
  score, higher-timeframe bias, confluence reasons, invalidation condition, chart image.
* Follow-up embeds: stop moved, exit (gain / loss), expired, invalidated.
* Anti-spam: cooldown per (pair, concept) and minimum score.
* Only VALIDATED concepts may send (``live.mode: alerts``). In observation mode nothing is sent.
"""
from __future__ import annotations

import io
import json
import time

import numpy as np
import requests

from ..core.config import get_secret
from ..core.logs import get_logger
from ..core.timeutil import ms_to_str

log = get_logger(__name__)
COLORS = {"long": 0x2ECC71, "short": 0xE74C3C, "info": 0x3498DB, "gain": 0x27AE60, "loss": 0xC0392B}
DISCLAIMER = "Signal issu d'un backtest, aucune garantie de résultat, risque de perte totale. Pas un conseil financier."


def _fmt(x: float) -> str:
    return f"{x:.6g}" if np.isfinite(x) else "–"


def signal_embed(sig: dict, status: dict | None = None) -> dict:
    d = sig["direction"]
    rule = sig["exit_rule"]
    entry, stop = float(sig["entry"]), float(sig["stop"])
    risk = abs(entry - stop)
    if rule.get("tp_r"):
        rr = f"{rule['tp_r']:.1f} R (objectif fixe)"
    elif rule.get("tp_price"):
        rr = f"{abs(rule['tp_price'] - entry) / risk:.1f} R (retour à la moyenne)" if risk > 0 else "–"
    else:
        rr = "ouvert (stop suiveur, pas d'objectif)"
    exit_txt = {"trail_chandelier": f"stop suiveur chandelier {rule.get('atr_mult')} ATR ({rule.get('tf')})",
                "trail_donchian": f"stop suiveur Donchian {rule.get('donchian_n')} ({rule.get('tf')})",
                "take_profit": f"objectif {rule.get('tp_r')} R", "mean": "retour à la moyenne"}[rule["kind"]]
    if rule.get("max_hold_bars"):
        exit_txt += f", sortie au plus tard après {rule['max_hold_bars']} bougies"
    fields = [
        {"name": "Paire", "value": sig["symbol"], "inline": True},
        {"name": "Direction", "value": "ACHAT (long)" if d == "long" else "VENTE (short)", "inline": True},
        {"name": "Concept", "value": f"{sig['concept']} ({sig['variant'].split('_', 1)[-1][:60]})", "inline": False},
        {"name": "TF signal / contexte", "value": f"{sig['tf_signal']} / {sig.get('tf_context') or '–'}", "inline": True},
        {"name": "Entrée", "value": f"{_fmt(entry)} ({'limite' if sig['order_type'] == 'limit' else 'marché, ouverture suivante'})", "inline": True},
        {"name": "Stop initial", "value": _fmt(stop), "inline": True},
        {"name": "Sortie", "value": exit_txt, "inline": False},
        {"name": "R:R estimé", "value": rr, "inline": True},
        {"name": "Score", "value": f"{sig.get('score', 0):.0f}", "inline": True},
        {"name": "Biais HTF", "value": next((r for r in sig.get("reasons", []) if r.startswith(("régime", "tendance"))), "–"), "inline": False},
        {"name": "Raisons", "value": "\n".join(f"• {r}" for r in sig.get("reasons", [])) or "–", "inline": False},
        {"name": "Invalidation", "value": sig.get("invalidation") or "–", "inline": False},
    ]
    return {"title": f"{'🟢' if d == 'long' else '🔴'} Setup {sig['symbol']} {d.upper()} ({sig['concept']})",
            "color": COLORS[d], "fields": fields, "footer": {"text": DISCLAIMER},
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(sig["generated_at"] / 1000)),
            "description": f"Détecté à la clôture du {ms_to_str(sig['generated_at'])} UTC. Id {sig['id']}."}


def followup_embed(sig: dict, kind: str, st: dict) -> dict:
    titles = {"stop_moved": "Stop remonté", "exit": "Position sortie", "expired": "Ordre expiré", "invalidated": "Signal invalidé",
              "entry": "Entrée exécutée (virtuelle)"}
    color = COLORS["info"]
    desc = []
    if kind == "stop_moved":
        desc.append(f"Nouveau stop : {_fmt(st.get('stop', np.nan))}")
    if kind == "entry":
        desc.append(f"Prix d'entrée : {_fmt(st.get('entry_price', np.nan))}, stop {_fmt(st.get('stop', np.nan))}")
    if kind == "exit":
        r = st.get("r_multiple", np.nan)
        color = COLORS["gain"] if r > 0 else COLORS["loss"]
        desc.append(f"Sortie à {_fmt(st.get('exit_price', np.nan))} ({st.get('exit_reason', '')}) : {r:+.2f} R net de frais")
    if kind == "invalidated" and st.get("reason"):
        desc.append(st["reason"])
    return {"title": f"{titles.get(kind, kind)} : {sig['symbol']} {sig['direction'].upper()} ({sig['concept']})",
            "color": color, "description": "\n".join(desc) + f"\nId {sig['id']}", "footer": {"text": DISCLAIMER}}


def chart_png(market, sig: dict, n: int = 120) -> bytes | None:
    """Candles of the signal timeframe before the signal, with entry and stop levels."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return None
    arr = market.tf.get(sig["tf_signal"]) if market is not None else None
    if arr is None:
        return None
    k = int(np.searchsorted(arr["ot"], sig["generated_at"])) - 1
    lo = max(0, k - n + 1)
    if k < 1:
        return None
    x = np.arange(k - lo + 1)
    h, l, c = arr["h"][lo:k + 1], arr["l"][lo:k + 1], arr["c"][lo:k + 1]
    fig, ax = plt.subplots(figsize=(8, 3.6))
    ax.vlines(x, l, h, color="grey", lw=0.8)
    ax.plot(x, c, color="black", lw=0.9)
    ax.axhline(sig["entry"], color="#2980b9", lw=1, label="entrée")
    ax.axhline(sig["stop"], color="#c0392b", lw=1, ls="--", label="stop")
    ax.set_title(f"{sig['symbol']} {sig['tf_signal']} : {sig['direction']} ({sig['concept']})")
    ax.legend(fontsize=7)
    buf = io.BytesIO()
    fig.tight_layout()
    fig.savefig(buf, format="png", dpi=90)
    plt.close(fig)
    return buf.getvalue()


class DiscordSender:
    def __init__(self, cfg: dict, dry_run: bool = False):
        self.cfg = cfg
        self.dry_run = dry_run
        self.url = None if dry_run else get_secret("DISCORD_WEBHOOK_URL")
        self.sent: list[dict] = []           # dry-run journal (tests)

    def send(self, embed: dict, image: bytes | None = None) -> bool:
        payload = {"embeds": [embed]}
        if image is not None:
            embed["image"] = {"url": "attachment://chart.png"}
        if self.dry_run or not self.url:
            self.sent.append({"payload": payload, "has_image": image is not None})
            return True
        for attempt in range(4):
            try:
                if image is not None:
                    r = requests.post(self.url, data={"payload_json": json.dumps(payload)},
                                      files={"files[0]": ("chart.png", image, "image/png")}, timeout=20)
                else:
                    r = requests.post(self.url, json=payload, timeout=20)
                if r.status_code in (200, 204):
                    return True
                if r.status_code == 429:
                    time.sleep(float(r.json().get("retry_after", 2)))
                    continue
                log.error("discord refused", status=r.status_code, body=r.text[:200])
                return False
            except requests.RequestException as exc:
                log.error("discord error", error=str(exc))
                time.sleep(2 ** attempt)
        return False
