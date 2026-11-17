"""Common data types shared by concepts, the backtest engine and the live scanner (Step 2)."""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum


class Direction(int, Enum):
    LONG = 1
    SHORT = -1


class ExitKind(str, Enum):
    TRAIL_CHANDELIER = "trail_chandelier"   # highest high (lowest low) since entry -/+ k ATR
    TRAIL_DONCHIAN = "trail_donchian"       # opposite Donchian channel of n candles
    TAKE_PROFIT = "take_profit"             # fixed target (price or multiple of R)
    MEAN = "mean"                           # target = moving average fixed at entry (mean reversion)


@dataclass(frozen=True)
class ExitRule:
    """How a position leaves the market once filled. Stops never move against the position."""
    kind: ExitKind
    atr_mult: float | None = None        # chandelier
    donchian_n: int | None = None        # Donchian trailing
    tp_r: float | None = None            # target in multiples of R
    tp_price: float | None = None        # absolute target
    max_hold_bars: int | None = None     # time exit, in candles of the signal timeframe
    tf: str | None = None                # timeframe whose closed candles update the trailing stop

    def describe(self) -> str:
        parts = []
        if self.kind == ExitKind.TRAIL_CHANDELIER:
            parts.append(f"stop suiveur : extrême depuis l'entrée ∓ {self.atr_mult} ATR ({self.tf})")
        elif self.kind == ExitKind.TRAIL_DONCHIAN:
            parts.append(f"stop suiveur : canal Donchian opposé {self.donchian_n} bougies ({self.tf})")
        elif self.kind == ExitKind.TAKE_PROFIT:
            parts.append(f"objectif {self.tp_r} R" if self.tp_r is not None else f"objectif {self.tp_price}")
        elif self.kind == ExitKind.MEAN:
            parts.append(f"objectif : retour à la moyenne ({self.tp_price})")
        if self.max_hold_bars:
            parts.append(f"sortie au plus tard après {self.max_hold_bars} bougies {self.tf}")
        return " ; ".join(parts)


@dataclass(frozen=True)
class Signal:
    """A setup detected on a CLOSED candle. Never modified nor deleted once emitted (rule 2).

    ``generated_at`` is the close time of the signal candle (the first instant the setup is known).
    ``entry`` is the reference price at generation (the signal candle close for market orders,
    the limit price for limit orders). The real fill is decided by the engine / the market.
    """
    symbol: str
    direction: Direction
    concept: str                    # "C1" .. "C5"
    variant: str                    # identifier of the parameter set
    tf_signal: str
    tf_context: str | None
    generated_at: int               # epoch ms, close of the signal candle
    entry: float
    order_type: str                 # "market" (next open) or "limit"
    stop: float
    exit_rule: ExitRule
    score: float = 0.0
    reasons: tuple[str, ...] = ()
    invalidation: str = ""
    limit_expiry: int | None = None  # epoch ms, limit orders only
    # Market orders only: when set, the stop is placed at fill price -/+ stop_offset (an ATR distance known
    # at the signal close). ``stop`` then holds the indicative level computed from the signal close.
    stop_offset: float | None = None
    atr: float = float("nan")         # ATR of the signal candle (used for sizing diagnostics)
    meta: tuple[tuple[str, float], ...] = field(default=())

    @property
    def id(self) -> str:
        """Deterministic identifier: the same setup always gets the same id (idempotence)."""
        key = f"{self.concept}|{self.variant}|{self.symbol}|{self.tf_signal}|{self.generated_at}|{int(self.direction)}"
        return hashlib.sha256(key.encode()).hexdigest()[:20]

    def to_dict(self) -> dict:
        d = asdict(self)
        d["direction"] = "long" if self.direction == Direction.LONG else "short"
        d["exit_rule"] = {k: (v.value if isinstance(v, Enum) else v) for k, v in asdict(self.exit_rule).items()}
        d["id"] = self.id
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True, default=str)
