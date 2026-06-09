"""
Script de test rapide — lance UN scan immédiat et affiche les résultats
dans la console, sans attendre la clôture 15m.

Usage :
    python test_signals.py

N'envoie PAS sur Discord (sauf si tu passes --discord).
Pratique pour vérifier que la connexion Binance et les calculs fonctionnent.
"""

import sys
import logging

import config
from src import signal_engine, discord_notifier
from src.utils import setup_logging, fmt_price


def main() -> None:
    setup_logging()
    log = logging.getLogger("test")
    send_discord = "--discord" in sys.argv

    log.info("Test sur %d symboles : %s", len(config.SYMBOLS), ", ".join(config.SYMBOLS))
    signals = signal_engine.scan_all()

    if not signals:
        log.info("Aucun signal pour le moment (c'est normal : les setups sont sélectifs).")
        return

    print("\n" + "=" * 60)
    for s in signals:
        print(f"  {s['symbol']:>10} | {s['direction']:<5} | {s['mode']:<5} | "
              f"entrée {fmt_price(s['entry'])} | SL {fmt_price(s['stop_loss'])} | "
              f"TP {fmt_price(s['take_profit'])} | fiab {s['reliability']}% | RR {s['rr']}:1")
    print("=" * 60 + "\n")

    if send_discord:
        log.info("Envoi des %d signal(aux) sur Discord...", len(signals))
        for s in signals:
            discord_notifier.send_signal(s)


if __name__ == "__main__":
    main()
