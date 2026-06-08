"""
Dédoublonnage et cooldown des signaux.
Empêche d'envoyer deux fois le même setup ou de spammer Discord.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from strategy.config import COOLDOWN_MINUTES
from strategy.strategy import Signal

logger = logging.getLogger(__name__)

# Précision d'arrondi pour le niveau d'entrée (dédoublonnage)
ENTRY_ROUND_DECIMALS = 2


class SignalManager:
    """
    Gère le cooldown et la déduplication des signaux.
    Un signal est bloqué si :
      1. Même (symbol, side, niveau d'entrée arrondi) dans la fenêtre de cooldown
      2. Même (symbol, side) dans la fenêtre de cooldown (anti-spam général)
    """

    def __init__(self, cooldown_minutes: int = COOLDOWN_MINUTES) -> None:
        self._cooldown = timedelta(minutes=cooldown_minutes)
        # Clé → datetime du dernier envoi
        self._last_sent: dict[str, datetime] = {}

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _entry_key(self, signal: Signal) -> str:
        """Clé précise : symbol + side + entrée arrondie."""
        rounded = round(signal.entry, ENTRY_ROUND_DECIMALS)
        return f"{signal.symbol}:{signal.side}:{rounded}"

    def _pair_key(self, signal: Signal) -> str:
        """Clé générale : symbol + side (cooldown global par paire/direction)."""
        return f"{signal.symbol}:{signal.side}"

    def is_allowed(self, signal: Signal) -> bool:
        """
        Retourne True si le signal peut être envoyé, False s'il est en cooldown.
        """
        now = self._now()

        # Vérification sur la clé précise
        entry_key = self._entry_key(signal)
        if entry_key in self._last_sent:
            elapsed = now - self._last_sent[entry_key]
            if elapsed < self._cooldown:
                remaining = int((self._cooldown - elapsed).total_seconds() / 60)
                logger.debug(
                    "Signal dupliqué ignoré : %s %s (cooldown: %dm restant)",
                    signal.symbol,
                    signal.side,
                    remaining,
                )
                return False

        # Vérification sur la clé générale (anti-spam par paire)
        pair_key = self._pair_key(signal)
        if pair_key in self._last_sent:
            elapsed = now - self._last_sent[pair_key]
            if elapsed < self._cooldown:
                remaining = int((self._cooldown - elapsed).total_seconds() / 60)
                logger.debug(
                    "Cooldown actif pour %s %s (%dm restant)",
                    signal.symbol,
                    signal.side,
                    remaining,
                )
                return False

        return True

    def record(self, signal: Signal) -> None:
        """Enregistre l'envoi d'un signal (à appeler après envoi réussi)."""
        now = self._now()
        self._last_sent[self._entry_key(signal)] = now
        self._last_sent[self._pair_key(signal)] = now
        logger.debug("Signal enregistré : %s %s", signal.symbol, signal.side)

    def cleanup_expired(self) -> None:
        """Supprime les entrées expirées pour éviter une fuite mémoire."""
        now = self._now()
        expired = [k for k, ts in self._last_sent.items() if now - ts > self._cooldown * 2]
        for k in expired:
            del self._last_sent[k]
