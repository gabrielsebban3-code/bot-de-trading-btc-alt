"""Structured logging: one JSON object per line on stderr (and optionally a file)."""
from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        extra = getattr(record, "fields", None)
        if extra:
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str, ensure_ascii=False)


def setup_logging(level: str = "INFO", file: Path | None = None) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(level)
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(JsonFormatter())
    root.addHandler(h)
    if file is not None:
        file.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(file, encoding="utf-8")
        fh.setFormatter(JsonFormatter())
        root.addHandler(fh)


def get_logger(name: str) -> logging.LoggerAdapter:
    return _Adapter(logging.getLogger(name), {})


class _Adapter(logging.LoggerAdapter):
    """``log.info("msg", symbol="BTCUSDT", rows=10)`` -> fields added to the JSON line."""

    def process(self, msg, kwargs):
        fields = {k: kwargs.pop(k) for k in list(kwargs) if k not in ("exc_info", "stack_info", "stacklevel", "extra")}
        kwargs["extra"] = {"fields": fields}
        return msg, kwargs
