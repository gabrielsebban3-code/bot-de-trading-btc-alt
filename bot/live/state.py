"""Live state in SQLite (Step 10): signals (never modified once emitted), statuses, events, concept status.

Idempotence: a signal id is a hash of (concept, variant, symbol, timeframe, close time, direction); inserting the
same signal twice is a no-op, so a restart never duplicates a signal or an alert.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import pandas as pd

from ..core.config import resolve_path
from ..core.types import Signal

SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id TEXT PRIMARY KEY, concept TEXT, variant TEXT, symbol TEXT, direction TEXT, tf TEXT,
    generated_at INTEGER, payload TEXT NOT NULL, holdout INTEGER DEFAULT 0, created_ms INTEGER
);
CREATE TABLE IF NOT EXISTS status (
    signal_id TEXT PRIMARY KEY, status TEXT NOT NULL, stop REAL, entry_time INTEGER, entry_price REAL,
    exit_time INTEGER, exit_price REAL, r_multiple REAL, updated_ms INTEGER
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, signal_id TEXT, kind TEXT, at_ms INTEGER, payload TEXT,
    sent INTEGER DEFAULT 0, UNIQUE(signal_id, kind, at_ms)
);
CREATE TABLE IF NOT EXISTS concept_status (
    variant TEXT PRIMARY KEY, enabled INTEGER NOT NULL, reason TEXT, updated_ms INTEGER
);
CREATE TABLE IF NOT EXISTS live_universe (
    month TEXT NOT NULL, symbol TEXT NOT NULL, rank INTEGER, avg_quote_volume REAL, PRIMARY KEY (month, symbol)
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
"""

STATUSES = ("en attente", "actif", "stop remonté", "sorti en gain", "sorti en perte", "expiré", "invalidé")


class StateStore:
    def __init__(self, cfg: dict, path: Path | None = None):
        self.path = Path(path) if path is not None else resolve_path(cfg, "state_db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(self.path, timeout=60)
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript(SCHEMA)
        self.con.commit()

    def add_signals(self, signals: list[Signal], holdout: set[str] | None = None) -> list[str]:
        """Insert new signals; returns the ids that were not known yet."""
        now = int(time.time() * 1000)
        new = []
        for s in signals:
            cur = self.con.execute(
                "INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?,?,?,?,?,?)",
                (s.id, s.concept, s.variant, s.symbol, "long" if int(s.direction) > 0 else "short", s.tf_signal,
                 s.generated_at, s.to_json(), int(bool(holdout and s.symbol in holdout)), now))
            if cur.rowcount:
                new.append(s.id)
        self.con.commit()
        return new

    def signals(self, variant: str | None = None) -> pd.DataFrame:
        q, p = "SELECT * FROM signals", ()
        if variant:
            q, p = q + " WHERE variant=?", (variant,)
        return pd.read_sql_query(q + " ORDER BY generated_at, symbol", self.con, params=p)

    def status(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM status", self.con)

    def set_status(self, signal_id: str, st: dict) -> None:
        self.con.execute("INSERT OR REPLACE INTO status VALUES (?,?,?,?,?,?,?,?,?)",
                         (signal_id, st["status"], st.get("stop"), st.get("entry_time"), st.get("entry_price"),
                          st.get("exit_time"), st.get("exit_price"), st.get("r_multiple"), int(time.time() * 1000)))
        self.con.commit()

    def add_event(self, signal_id: str, kind: str, at_ms: int, payload: dict) -> bool:
        cur = self.con.execute("INSERT OR IGNORE INTO events (signal_id, kind, at_ms, payload) VALUES (?,?,?,?)",
                               (signal_id, kind, int(at_ms), json.dumps(payload, default=str)))
        self.con.commit()
        return bool(cur.rowcount)

    def unsent_events(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM events WHERE sent=0 ORDER BY at_ms, id", self.con)

    def mark_sent(self, event_id: int) -> None:
        self.con.execute("UPDATE events SET sent=1 WHERE id=?", (int(event_id),))
        self.con.commit()

    def last_event_ms(self, symbol: str, concept: str, kind: str = "signal") -> int | None:
        row = self.con.execute(
            "SELECT MAX(e.at_ms) FROM events e JOIN signals s ON s.id=e.signal_id WHERE s.symbol=? AND s.concept=? "
            "AND e.kind=? AND e.sent=1", (symbol, concept, kind)).fetchone()
        return row[0]

    def concept_enabled(self, variant: str) -> bool:
        row = self.con.execute("SELECT enabled FROM concept_status WHERE variant=?", (variant,)).fetchone()
        return True if row is None else bool(row[0])

    def set_concept(self, variant: str, enabled: bool, reason: str) -> None:
        self.con.execute("INSERT OR REPLACE INTO concept_status VALUES (?,?,?,?)",
                         (variant, int(enabled), reason, int(time.time() * 1000)))
        self.con.commit()

    def set_universe(self, month: str, ranked: list[tuple[str, float]]) -> None:
        self.con.execute("DELETE FROM live_universe WHERE month=?", (month,))
        self.con.executemany("INSERT INTO live_universe VALUES (?,?,?,?)",
                             [(month, s, i + 1, v) for i, (s, v) in enumerate(ranked)])
        self.con.commit()

    def universe(self, month: str) -> list[str]:
        return [r[0] for r in self.con.execute("SELECT symbol FROM live_universe WHERE month=? ORDER BY rank", (month,))]

    def get(self, key: str) -> str | None:
        row = self.con.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return None if row is None else row[0]

    def put(self, key: str, value: str) -> None:
        self.con.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (key, value))
        self.con.commit()
