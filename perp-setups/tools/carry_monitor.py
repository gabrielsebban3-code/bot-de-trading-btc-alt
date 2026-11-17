"""Carry monitor for paper trading (study 7). Public data only: no API key, no order is ever sent.

Once a day, after 00:05 UTC:
    python tools/carry_monitor.py                       # prints the pairs to hold and updates the paper journal
    python tools/carry_monitor.py --exchange okx        # same with OKX public data
    DISCORD_WEBHOOK_URL=... python tools/carry_monitor.py --discord

Rule (PROTOCOLE_ETUDE_7.md): hold "long spot + short perpetual, same notional" on a pair while the mean funding rate
of the last 14 days is above 0; close both legs when it falls to 0 or below.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PAIRS = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "ADA", "LINK", "AVAX", "LTC"]
WINDOW_DAYS = 14
JOURNAL = Path(__file__).with_name("carry_paper_journal.csv")
STATE = Path(__file__).with_name("carry_state.json")


def http_json(url: str, tries: int = 3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "carry-monitor"}), timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def funding_history(exchange: str, coin: str, since_ms: int) -> list[tuple[int, float]]:
    """(settlement time in ms, rate) for the last 14 days."""
    if exchange == "binance":
        rows = http_json(f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={coin}USDT&startTime={since_ms}&limit=1000")
        return [(int(x["fundingTime"]), float(x["fundingRate"])) for x in rows]
    rows = http_json(f"https://www.okx.com/api/v5/public/funding-rate-history?instId={coin}-USDT-SWAP&limit=100")["data"]
    return [(int(x["fundingTime"]), float(x["realizedRate"])) for x in rows if int(x["fundingTime"]) >= since_ms]


def decide(history: list[tuple[int, float]], now_ms: int) -> dict:
    """Mean daily funding over the last 14 days, annualised, and the decision."""
    start = now_ms - WINDOW_DAYS * 86_400_000
    rates = [r for t, r in history if start <= t < now_ms]
    if not rates:
        return {"annual_pct": None, "hold": False, "n": 0}
    daily = sum(rates) / WINDOW_DAYS                      # sum of settlements divided by the number of days
    return {"annual_pct": round(100 * daily * 365, 2), "hold": daily > 0, "n": len(rates)}


def run(exchange: str, discord: bool, now: datetime | None = None, fetch=funding_history) -> list[dict]:
    now = now or datetime.now(timezone.utc)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    now_ms = int(day.timestamp() * 1000)
    previous = json.loads(STATE.read_text()) if STATE.exists() else {}
    out = []
    for coin in PAIRS:
        try:
            d = decide(fetch(exchange, coin, now_ms - (WINDOW_DAYS + 1) * 86_400_000), now_ms)
            action = ("OUVRIR" if d["hold"] and not previous.get(coin) else "FERMER" if not d["hold"] and previous.get(coin)
                      else "GARDER" if d["hold"] else "rien")
            out.append({"date": day.date().isoformat(), "coin": coin, **d, "action": action})
        except Exception as e:                                # an error never produces a signal
            out.append({"date": day.date().isoformat(), "coin": coin, "annual_pct": None, "hold": previous.get(coin, False),
                        "n": 0, "action": f"ERREUR ({type(e).__name__}) : position inchangée"})
    STATE.write_text(json.dumps({r["coin"]: bool(r["hold"]) for r in out}))
    new = not JOURNAL.exists()
    with JOURNAL.open("a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["date", "coin", "annual_pct", "hold", "n", "action"])
        if new:
            w.writeheader()
        w.writerows(out)
    lines = [f"{r['coin']:5s} funding 14 j : {r['annual_pct'] if r['annual_pct'] is not None else '—':>7} %/an  -> {r['action']}" for r in out]
    text = (f"Carry {exchange} {day.date()} (paper trading, non validé, aucun ordre)\n" + "\n".join(lines))
    print(text)
    if discord:
        url = os.environ.get("DISCORD_WEBHOOK_URL")
        if not url:
            print("DISCORD_WEBHOOK_URL absent : message non envoyé", file=sys.stderr)
        else:
            body = json.dumps({"content": "```\n" + text[:1900] + "\n```"}).encode()
            urllib.request.urlopen(urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}), timeout=20)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--exchange", choices=["binance", "okx"], default="binance")
    ap.add_argument("--discord", action="store_true")
    a = ap.parse_args()
    run(a.exchange, a.discord)
