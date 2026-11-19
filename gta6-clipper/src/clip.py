"""Fabrication d'un clip (segment téléchargé -> rendu vertical -> miniature) et gestion des fichiers."""
import json
import time
from pathlib import Path

from . import download, vertical


def clip_id(vid: str, start: float) -> str:
    return f"{vid}_{int(start)}"


def make_clip(video: dict, moment: dict, segments, cfg, workdir: Path, data: Path, source=None) -> dict:
    """source : fichier déjà découpé (tests) ; sinon seul le segment est téléchargé."""
    start, end = moment["start"], moment["end"]
    cid = clip_id(video["id"], start)
    src = source or download.download_section(video["id"], start, end, workdir, cfg["render"]["max_source_height"])
    duration = vertical.probe_duration(src) or (end - start)
    r = cfg["render"]
    events = vertical.subtitle_events(segments, start, end, max_words=r.get("subtitle_max_words", 3),
                                      highlight=r.get("subtitle_highlight", True),
                                      upper=r.get("subtitle_uppercase", False)) if r["subtitles"] else []
    ass_name = f"subs_{cid}.ass"
    (workdir / ass_name).write_text(
        vertical.build_ass(events, f"Source : {video['channel']}", duration, cfg["render"]["font"]), encoding="utf-8")
    out = data / "clips" / f"{cid}.mp4"
    tmp = workdir / f"{cid}.render.mp4"
    vertical.render_vertical(Path(src).resolve(), tmp.resolve(), ass_name, workdir, cfg["render"])
    tmp.replace(out)  # le fichier n'apparaît sur le site qu'une fois complet
    vertical.thumbnail(out, data / "thumbs" / f"{cid}.jpg", duration / 2)
    return {"id": cid, "video_id": video["id"], "video_title": video["title"], "channel": video["channel"],
            "url": video["url"], "start": start, "end": end, "score": moment["score"],
            "created_at": time.time(), "file_size": out.stat().st_size,
            "reasons": json.dumps(moment.get("signals", {}))}


def clip_paths(data: Path, cid: str):
    return data / "clips" / f"{cid}.mp4", data / "thumbs" / f"{cid}.jpg"


def remove_clip(db, data: Path, cid: str) -> None:
    for p in clip_paths(data, cid):
        p.unlink(missing_ok=True)
    db.delete_clip(cid)


def disk_usage(data: Path) -> int:
    return sum(p.stat().st_size for sub in ("clips", "thumbs") for p in (data / sub).glob("*") if p.is_file())


def cleanup_disk(db, data: Path, ccfg) -> int:
    """Supprime les clips non favoris trop vieux, puis les plus anciens si le plafond est dépassé."""
    if not ccfg.get("enabled"):
        return 0
    removed, now = 0, time.time()
    clips = [c for c in db.list_clips(sort="old") if not c["favorite"]]
    for c in list(clips):
        if now - c["created_at"] > ccfg["max_age_days"] * 86400:
            remove_clip(db, data, c["id"])
            clips.remove(c)
            removed += 1
    limit = ccfg["max_total_gb"] * 1024 ** 3
    total = disk_usage(data)
    for c in clips:
        if total <= limit:
            break
        mp4, jpg = clip_paths(data, c["id"])
        total -= sum(p.stat().st_size for p in (mp4, jpg) if p.exists())
        remove_clip(db, data, c["id"])
        removed += 1
    return removed
