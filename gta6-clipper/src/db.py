import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, title TEXT, channel TEXT, url TEXT, published_at TEXT,
  duration REAL, views INTEGER, likes INTEGER, score REAL,
  status TEXT, error TEXT, processed_at REAL
);
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY, video_id TEXT, video_title TEXT, channel TEXT, url TEXT,
  start REAL, end REAL, score REAL, created_at REAL,
  seen INTEGER DEFAULT 0, favorite INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS clips_video ON clips(video_id);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT, created_at REAL);
"""


class DB:
    def __init__(self, path: Path):
        self.path = Path(path)
        with self.conn() as c:
            c.executescript(SCHEMA)

    @contextmanager
    def conn(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()

    # --- cache générique (recherches, infos vidéo, transcriptions, LLM) ---
    def cache_get(self, key: str, max_age_s: float | None = None):
        with self.conn() as c:
            r = c.execute("SELECT value, created_at FROM cache WHERE key=?", (key,)).fetchone()
        if not r or (max_age_s is not None and time.time() - r["created_at"] > max_age_s):
            return None
        return json.loads(r["value"])

    def cache_set(self, key: str, value) -> None:
        with self.conn() as c:
            c.execute("INSERT OR REPLACE INTO cache VALUES (?,?,?)", (key, json.dumps(value), time.time()))

    # --- vidéos ---
    def video_known(self, vid: str) -> bool:
        with self.conn() as c:
            return c.execute("SELECT 1 FROM videos WHERE id=?", (vid,)).fetchone() is not None

    def upsert_video(self, v: dict, status: str, error: str | None = None) -> None:
        with self.conn() as c:
            c.execute(
                "INSERT OR REPLACE INTO videos VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (v["id"], v.get("title"), v.get("channel"), v.get("url"), v.get("published_at"),
                 v.get("duration"), v.get("views"), v.get("likes"), v.get("score"), status, error, time.time()),
            )

    def list_videos(self):
        with self.conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM videos ORDER BY processed_at DESC")]

    # --- clips ---
    def add_clip(self, clip: dict) -> None:
        cols = ("id", "video_id", "video_title", "channel", "url", "start", "end", "score", "created_at", "file_size")
        with self.conn() as c:
            c.execute(
                f"INSERT OR REPLACE INTO clips ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                tuple(clip.get(k, time.time() if k == "created_at" else None) for k in cols),
            )

    def get_clip(self, cid: str):
        with self.conn() as c:
            r = c.execute("SELECT * FROM clips WHERE id=?", (cid,)).fetchone()
        return dict(r) if r else None

    def list_clips(self, show="all", video=None, channel=None, sort="date"):
        q, args = "SELECT * FROM clips WHERE 1=1", []
        if show == "unseen":
            q += " AND seen=0"
        elif show == "fav":
            q += " AND favorite=1"
        if video:
            q += " AND video_id=?"
            args.append(video)
        if channel:
            q += " AND channel=?"
            args.append(channel)
        q += {"score": " ORDER BY score DESC", "old": " ORDER BY created_at ASC"}.get(sort, " ORDER BY created_at DESC, start ASC")
        with self.conn() as c:
            return [dict(r) for r in c.execute(q, args)]

    def facets(self):
        with self.conn() as c:
            videos = [dict(r) for r in c.execute("SELECT DISTINCT video_id, video_title FROM clips ORDER BY video_title")]
            channels = [r[0] for r in c.execute("SELECT DISTINCT channel FROM clips ORDER BY channel")]
        return videos, channels

    def set_flag(self, cid: str, flag: str, value: int) -> None:
        assert flag in ("seen", "favorite")
        with self.conn() as c:
            c.execute(f"UPDATE clips SET {flag}=? WHERE id=?", (value, cid))

    def delete_clip(self, cid: str) -> None:
        with self.conn() as c:
            c.execute("DELETE FROM clips WHERE id=?", (cid,))

    def counts(self):
        with self.conn() as c:
            r = c.execute("SELECT COUNT(*), SUM(seen=0), SUM(favorite=1) FROM clips").fetchone()
            nv = c.execute("SELECT COUNT(*) FROM videos").fetchone()[0]
        return {"clips": r[0] or 0, "unseen": r[1] or 0, "favorites": r[2] or 0, "videos": nv}
