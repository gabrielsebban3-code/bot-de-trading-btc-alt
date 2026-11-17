"""Configuration loading. Every tunable value lives in ``bot/config.yaml`` (rule 4).

Secrets are read from the environment (optionally from ``bot/.env``) and never from the YAML file.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import yaml

BOT_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BOT_DIR.parent
CONFIG_PATH = BOT_DIR / "config.yaml"


def _deep_update(base: dict, overlay: dict) -> dict:
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_update(base[key], value)
        else:
            base[key] = value
    return base


def load_config(path: Path | str | None = None, overlay: dict | None = None) -> dict:
    """Load ``config.yaml`` (or ``path``) and apply an optional overlay (deep merge)."""
    with open(path or CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh)
    if overlay:
        cfg = _deep_update(copy.deepcopy(cfg), overlay)
    return cfg


def config_hash(cfg: dict) -> str:
    """Stable short hash of a configuration (stored with every run and trial)."""
    blob = json.dumps(cfg, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()[:16]


def resolve_path(cfg: dict, key: str) -> Path:
    """Absolute path of ``cfg['paths'][key]`` (paths in the YAML are relative to the repository root)."""
    p = Path(cfg["paths"][key])
    return p if p.is_absolute() else REPO_DIR / p


def get_secret(name: str, required: bool = False) -> str | None:
    """Read a secret from the environment, loading ``bot/.env`` first when it exists."""
    env_file = BOT_DIR / ".env"
    if env_file.exists():
        try:
            from dotenv import load_dotenv
            load_dotenv(env_file, override=False)
        except ImportError:  # python-dotenv missing: rely on the real environment only
            pass
    value = os.environ.get(name)
    if required and not value:
        raise RuntimeError(f"missing secret {name}: set it in bot/.env or in the environment")
    return value


def get(cfg: dict, dotted: str, default: Any = None) -> Any:
    """``get(cfg, 'risk.correlation.threshold')``."""
    cur: Any = cfg
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur
