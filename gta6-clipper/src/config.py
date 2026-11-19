import copy
import os
from pathlib import Path

import yaml

ROOT = Path(os.environ.get("GTA6_CLIPPER_HOME", Path(__file__).resolve().parents[1]))

CONFIG_VERSION = 2  # v2 : clips d'au moins 1 minute

DEFAULTS = {
    "version": CONFIG_VERSION,
    "search": {
        "queries": ["GTA 6", "GTA VI gameplay", "GTA 6 trailer analyse", "GTA 6 test", "GTA 6 avis", "GTA 6 map"],
        "days": 7, "min_duration_min": 3, "max_duration_min": 40, "min_views": 5000, "top_n": 5,
        "results_per_query": 15, "max_candidates": 20, "cache_hours": 6, "max_attempts": 3,
        "channel_whitelist": [], "channel_blacklist": [],
    },
    "moments": {
        "clips_per_video": 3, "min_clip_s": 60, "max_clip_s": 90, "target_clip_s": 70,
        "min_gap_s": 60, "margin_s": 0.5, "learn_from_ratings": True, "min_speech_ratio": 0.5, "min_video_speech_ratio": 0.15,
        "weights": {"heatmap": 0.5, "audio": 0.25, "keywords": 0.25, "comments": 0.4, "chat": 0.6},
        "skip_intro_s": 60, "skip_outro_s": 45,
        # réactions orales (s'ajoutent à keywords, même si config.yaml a sa propre liste)
        "reaction_words": ["mdr", "ptdr", "wow", "waouh", "putain", "oh non", "oh là", "c'est fou", "c'est ouf",
                           "trop beau", "magnifique", "attends", "mais non", "la police", "j'y crois pas",
                           "hein", "aïe", "nooon", "ouais"],
        "keywords": ["incroyable", "regardez", "énorme", "confirmé", "nouveau", "map", "date de sortie"],
        "llm": {"enabled": False, "model": "claude-haiku-5-5", "weight": 0.3},
    },
    "transcription": {"model": "small", "language": "fr", "compute_type": "int8", "check_language": True,
                      "mode": "rapide", "cpu_threads": 0},
    "render": {"layout": "zoom", "title": "auto", "title_style": "encadre", "subtitles": True, "subtitle_max_words": 3, "subtitle_highlight": True,
               "subtitle_uppercase": True, "jump_cuts": True, "jump_cut_min_silence": 0.7, "crf": 21, "preset": "veryfast", "max_source_height": 1080, "font": "DejaVu Sans"},
    "cleanup": {"enabled": True, "max_age_days": 30, "max_total_gb": 10},
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def config_path() -> Path:
    return ROOT / "config.yaml"


def data_dir() -> Path:
    d = Path(os.environ.get("GTA6_CLIPPER_DATA", ROOT / "data"))
    for sub in ("clips", "thumbs", "tmp"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    return d


def load_env(path: Path | None = None) -> None:
    """Parseur .env minimal (KEY=VALUE), ne remplace pas les variables déjà définies."""
    path = path or ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if v:
            os.environ.setdefault(k.strip(), v)


def load_config() -> dict:
    p = config_path()
    user = (yaml.safe_load(p.read_text(encoding="utf-8")) if p.exists() else {}) or {}
    cfg = _merge(DEFAULTS, user)
    if user and int(user.get("version", 1)) < CONFIG_VERSION:
        # mise à niveau unique d'un config.yaml existant (maj.bat ne le remplace pas) : clips de 60 à 90 s
        m = cfg["moments"]
        m["min_clip_s"], m["max_clip_s"], m["target_clip_s"] = 60, 90, 70
        cfg["version"] = CONFIG_VERSION
        save_config(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    text = "# gta6-clipper : réglages (réécrit par la page Réglages du site)\n"
    text += yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)
    tmp = config_path().with_suffix(".yaml.tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(config_path())
