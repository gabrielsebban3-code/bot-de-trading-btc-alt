"""SQLite storage for market data (candles, funding, open interest, catalogue, universe).

The final-test lock is enforced HERE: no read function returns a row at or after
``final_test.start`` unless ``final_test.unlocked`` is true (rule 8, PROTOCOLE.md).
"""
from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterable, Iterator

import numpy as np
import pandas as pd

from ..core.config import resolve_path
from ..core.timeutil import to_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS candles (
    symbol TEXT NOT NULL, tf TEXT NOT NULL, open_time INTEGER NOT NULL,
    open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
    volume REAL NOT NULL, quote_volume REAL NOT NULL, trades INTEGER, taker_buy_quote REAL,
    PRIMARY KEY (symbol, tf, open_time)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS funding (
    symbol TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL,
    PRIMARY KEY (symbol, time)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS open_interest (
    symbol TEXT NOT NULL, time INTEGER NOT NULL, oi REAL, oi_value REAL,
    PRIMARY KEY (symbol, time)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog (
    symbol TEXT PRIMARY KEY, base TEXT, eligible INTEGER NOT NULL, reason TEXT,
    first_month TEXT, last_month TEXT
);
CREATE TABLE IF NOT EXISTS files (
    url TEXT PRIMARY KEY, kind TEXT, symbol TEXT, period TEXT, status TEXT NOT NULL,
    sha256 TEXT, rows INTEGER, fetched_at INTEGER
);
CREATE TABLE IF NOT EXISTS universe (
    month TEXT NOT NULL, symbol TEXT NOT NULL, rank INTEGER NOT NULL, avg_quote_volume REAL NOT NULL,
    PRIMARY KEY (month, symbol)
);
CREATE TABLE IF NOT EXISTS holdout (
    symbol TEXT PRIMARY KEY, holdout INTEGER NOT NULL, rule TEXT NOT NULL, frozen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

CANDLE_COLS = ["open_time", "open", "high", "low", "close", "volume", "quote_volume", "trades", "taker_buy_quote"]


class FinalTestLockedError(RuntimeError):
    """Raised when code tries to read data of the locked final-test period."""


def readable_end_ms(cfg: dict) -> int:
    """Exclusive upper bound of readable data: the final-test start while the lock is on."""
    if cfg["final_test"].get("unlocked", False):
        return np.iinfo("int64").max
    return to_ms(cfg["final_test"]["start"])


class MarketStore:
    def __init__(self, cfg: dict, path: Path | None = None):
        self.cfg = cfg
        self.path = Path(path) if path is not None else resolve_path(cfg, "market_db")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._con = sqlite3.connect(self.path, timeout=120, check_same_thread=False)
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.execute("PRAGMA synchronous=NORMAL")
        self._con.executescript(SCHEMA)
        self._con.commit()

    def close(self) -> None:
        self._con.close()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        try:
            yield self._con
            self._con.commit()
        except Exception:
            self._con.rollback()
            raise

    # ------------------------------------------------------------ lock
    def _check_end(self, end_ms: int | None) -> int:
        limit = readable_end_ms(self.cfg)
        if end_ms is None:
            return limit
        if end_ms > limit:
            raise FinalTestLockedError(
                f"requested data up to {end_ms} beyond the final-test lock ({self.cfg['final_test']['start']})")
        return end_ms

    # ------------------------------------------------------------ writes
    def upsert_candles(self, symbol: str, tf: str, df: pd.DataFrame) -> int:
        if df.empty:
            return 0
        lock = readable_end_ms(self.cfg)
        df = df[df["open_time"] < lock]           # never store locked data by accident
        rows = [(symbol, tf, int(r.open_time), float(r.open), float(r.high), float(r.low), float(r.close),
                 float(r.volume), float(r.quote_volume),
                 None if pd.isna(r.trades) else int(r.trades),
                 None if pd.isna(r.taker_buy_quote) else float(r.taker_buy_quote))
                for r in df.itertuples(index=False)]
        with self.tx() as con:
            con.executemany("INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
        return len(rows)

    def upsert_funding(self, symbol: str, df: pd.DataFrame) -> int:
        lock = readable_end_ms(self.cfg)
        df = df[df["time"] < lock]
        rows = [(symbol, int(t), float(r)) for t, r in zip(df["time"], df["rate"])]
        with self.tx() as con:
            con.executemany("INSERT OR REPLACE INTO funding VALUES (?,?,?)", rows)
        return len(rows)

    def upsert_oi(self, symbol: str, df: pd.DataFrame) -> int:
        lock = readable_end_ms(self.cfg)
        df = df[df["time"] < lock]
        rows = [(symbol, int(t), float(a), float(b)) for t, a, b in zip(df["time"], df["oi"], df["oi_value"])]
        with self.tx() as con:
            con.executemany("INSERT OR REPLACE INTO open_interest VALUES (?,?,?,?)", rows)
        return len(rows)

    def record_file(self, url: str, kind: str, symbol: str, period: str, status: str,
                    sha256: str | None = None, rows: int | None = None) -> None:
        with self.tx() as con:
            con.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?,?,?)",
                        (url, kind, symbol, period, status, sha256, rows, int(time.time() * 1000)))

    def file_done(self, url: str) -> bool:
        row = self._con.execute("SELECT status FROM files WHERE url=?", (url,)).fetchone()
        return row is not None and row[0] in ("ok", "missing")

    def set_catalog(self, rows: Iterable[tuple]) -> None:
        with self.tx() as con:
            con.executemany("INSERT OR REPLACE INTO catalog VALUES (?,?,?,?,?,?)", list(rows))

    def set_universe(self, month: str, ranked: list[tuple[str, float]]) -> None:
        with self.tx() as con:
            con.execute("DELETE FROM universe WHERE month=?", (month,))
            con.executemany("INSERT INTO universe VALUES (?,?,?,?)",
                            [(month, s, i + 1, v) for i, (s, v) in enumerate(ranked)])

    def set_holdout(self, rows: list[tuple[str, int, str, str]]) -> None:
        existing = self._con.execute("SELECT COUNT(*) FROM holdout").fetchone()[0]
        if existing:
            raise RuntimeError("the held-out list is frozen and cannot be rewritten")
        with self.tx() as con:
            con.executemany("INSERT INTO holdout VALUES (?,?,?,?)", rows)

    def set_meta(self, key: str, value: str) -> None:
        with self.tx() as con:
            con.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, value))

    # ------------------------------------------------------------ reads
    def candles(self, symbol: str, tf: str, start_ms: int | None = None, end_ms: int | None = None) -> pd.DataFrame:
        """Candles of [start_ms, end_ms) ordered by open time. ``open_time`` is int64 ms."""
        end = self._check_end(end_ms)
        start = -1 if start_ms is None else int(start_ms)
        df = pd.read_sql_query(
            "SELECT open_time, open, high, low, close, volume, quote_volume, trades, taker_buy_quote "
            "FROM candles WHERE symbol=? AND tf=? AND open_time>=? AND open_time<? ORDER BY open_time",
            self._con, params=(symbol, tf, start, min(end, np.iinfo("int64").max)))
        df["open_time"] = df["open_time"].astype("int64")
        return df

    def funding(self, symbol: str, start_ms: int | None = None, end_ms: int | None = None) -> pd.DataFrame:
        end = self._check_end(end_ms)
        df = pd.read_sql_query("SELECT time, rate FROM funding WHERE symbol=? AND time>=? AND time<? ORDER BY time",
                               self._con, params=(symbol, -1 if start_ms is None else start_ms, end))
        df["time"] = df["time"].astype("int64")
        return df

    def open_interest(self, symbol: str, start_ms: int | None = None, end_ms: int | None = None) -> pd.DataFrame:
        end = self._check_end(end_ms)
        df = pd.read_sql_query(
            "SELECT time, oi, oi_value FROM open_interest WHERE symbol=? AND time>=? AND time<? ORDER BY time",
            self._con, params=(symbol, -1 if start_ms is None else start_ms, end))
        df["time"] = df["time"].astype("int64")
        return df

    def catalog(self, eligible_only: bool = True) -> pd.DataFrame:
        q = "SELECT * FROM catalog" + (" WHERE eligible=1" if eligible_only else "") + " ORDER BY symbol"
        return pd.read_sql_query(q, self._con)

    def universe(self, month: str | None = None) -> pd.DataFrame:
        if month is None:
            return pd.read_sql_query("SELECT * FROM universe ORDER BY month, rank", self._con)
        return pd.read_sql_query("SELECT * FROM universe WHERE month=? ORDER BY rank", self._con, params=(month,))

    def holdout(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM holdout ORDER BY symbol", self._con)

    def symbols_with(self, tf: str) -> list[str]:
        rows = self._con.execute("SELECT DISTINCT symbol FROM candles WHERE tf=? ORDER BY symbol", (tf,)).fetchall()
        return [r[0] for r in rows]

    def files(self, kind: str | None = None) -> pd.DataFrame:
        if kind is None:
            return pd.read_sql_query("SELECT * FROM files", self._con)
        return pd.read_sql_query("SELECT * FROM files WHERE kind=?", self._con, params=(kind,))

    def meta(self, key: str) -> str | None:
        row = self._con.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return None if row is None else row[0]
