"""
Utilitaires : logging, formatage des prix, et anti-doublon de signaux.
"""

import logging


def setup_logging() -> None:
    """Configure un logging lisible vers la console (visible dans les logs Railway)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Réduit le bruit des libs réseau.
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("requests").setLevel(logging.WARNING)


def fmt_price(price: float) -> str:
    """
    Formate un prix avec un nombre de décimales adapté à sa magnitude
    (BTC à 95 000 $ vs DOGE à 0.12 $).
    """
    if price >= 1000:
        return f"{price:,.2f}"
    if price >= 1:
        return f"{price:,.4f}"
    if price >= 0.01:
        return f"{price:.5f}"
    return f"{price:.7f}"


class SignalDeduper:
    """
    Empêche d'envoyer plusieurs fois la même alerte.

    Une alerte est identifiée par (symbole, type de signal, heure de la bougie).
    Tant qu'une nouvelle bougie 15m n'est pas clôturée, on ne ré-alerte pas
    le même setup sur le même actif.
    """

    def __init__(self) -> None:
        self._seen: dict[str, str] = {}

    def is_new(self, symbol: str, signal_type: str, candle_time: str) -> bool:
        key = f"{symbol}:{signal_type}"
        stamp = str(candle_time)
        if self._seen.get(key) == stamp:
            return False
        self._seen[key] = stamp
        return True
