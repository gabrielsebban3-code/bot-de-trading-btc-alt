"""
Dédoublonnage et cooldown des signaux.
Empêche d'envoyer deux fois le même setup ou de spammer Discord.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from strategy.config import COOLDOWN_MINUTES, MIN_SCORE
from strategy.strategy import Signal

logger = logging.getLogger(__name__)


class SignalManager:
    """
    Gère le cooldown et la déduplication des signaux.
    Un signal est bloqué si :
      1. Même bougie déclencheur (symbol + side + timestamp de la bougie)
      2. Même (symbol, side) dans la fenêtre de cooldown général
      3. Score < MIN_SCORE
    """

    def __init__(self, cooldown_minutes: int = COOLDOWN_MINUTES) -> None:
        self._cooldown = timedelta(minutes=cooldown_minutes)
        self._last_sent: dict[str, datetime] = {}
        # Set des clés de bougie déjà traitées (évite le spam inter-scans sur la même bougie)
        self._seen_candles: set[str] = set()

    def _now(self) -> datetime:
        return datetime.now(timezone.utc)

    def _candle_key(self, signal: Signal) -> str:
        """Clé unique par bougie déclencheur : symbol + side + minute exacte."""
        # Tronquer au début de la minute pour identifier la bougie
        ts = signal.timestamp.replace(second=0, microsecond=0)
        return f"{signal.symbol}:{signal.side}:{ts.isoformat()}"

    def _pair_key(self, signal: Signal) -> str:
        return f"{signal.symbol}:{signal.side}"

    def is_allowed(self, signal: Signal) -> bool:
        """Retourne True si le signal peut être envoyé."""
        now = self._now()

        # 1. Filtre score minimum
        if signal.score < MIN_SCORE:
            logger.debug("Score trop faible %s %s : %d < %d", signal.symbol, signal.side, signal.score, MIN_SCORE)
            return False

        # 2. Même bougie déjà traitée → jamais deux fois
        candle_key = self._candle_key(signal)
        if candle_key in self._seen_candles:
            logger.debug("Bougie déjà traitée : %s", candle_key)
            return False

        # 3. Cooldown général par paire/direction
        pair_key = self._pair_key(signal)
        if pair_key in self._last_sent:
            elapsed = now - self._last_sent[pair_key]
            if elapsed < self._cooldown:
                remaining = int((self._cooldown - elapsed).total_seconds() / 60)
                logger.debug("Cooldown actif %s %s (%dm restant)", signal.symbol, signal.side, remaining)
                return False

        return True

    def record(self, signal: Signal) -> None:
        """Enregistre l'envoi d'un signal."""
        now = self._now()
        self._seen_candles.add(self._candle_key(signal))
        self._last_sent[self._pair_key(signal)] = now
        logger.debug("Signal enregistré : %s %s score=%d", signal.symbol, signal.side, signal.score)

    def cleanup_expired(self) -> None:
        """Nettoie les entrées expirées (appelé toutes les 100 itérations)."""
        now = self._now()
        expired_pairs = [k for k, ts in self._last_sent.items() if now - ts > self._cooldown * 2]
        for k in expired_pairs:
            del self._last_sent[k]
        # Garder seulement les bougies des dernières 2h (120 bougies 1m)
        if len(self._seen_candles) > 500:
            self._seen_candles.clear()
