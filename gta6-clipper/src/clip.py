"""Fabrication d'un clip (segment téléchargé -> rendu vertical -> miniature) et gestion des fichiers."""
import json
import re
import shutil
import time
from pathlib import Path

from . import download, vertical


def clip_id(vid: str, start: float) -> str:
    return f"{vid}_{int(start)}"


def clean_text(t: str) -> str:
    """Retire les emojis (la police du rendu ne sait pas les dessiner) et les espaces en trop."""
    t = "".join(ch for ch in t or "" if ord(ch) <= 0xFFFF and not 0xFE00 <= ord(ch) <= 0xFE0F and ord(ch) != 0x200D)
    t = re.sub(r"[\u2600-\u27BF]", "", t)
    return re.sub(r"\s+", " ", t).strip()


def shorten(t: str, limit: int) -> str:
    if len(t) <= limit:
        return t
    return t[:limit].rsplit(" ", 1)[0].rstrip(" ,;:-") + "…"


def hook_title(segments, start, end, video: dict, mode: str = "auto", mcfg=None) -> str:
    """Titre accrocheur affiché en haut du clip. auto : « phrase la plus frappante du passage » précédée de la
    chaîne (comme les pages de clips) ; à défaut, le titre de la vidéo. video : titre de la vidéo. none : aucun."""
    if mode == "none":
        return ""
    fallback = shorten(clean_text(video.get("title", "")), 70)
    if mode == "video":
        return fallback
    words = [w.lower() for w in (mcfg or {}).get("keywords", []) + (mcfg or {}).get("reaction_words", [])]
    text = " ".join(s["text"] for s in segments if s["end"] > start and s["start"] < end)
    best = None
    for sen in re.split(r"(?<=[.!?…])\s+", clean_text(text)):
        sen = sen.strip(" -–—\"'«»")
        n = len(sen.split())
        if not 3 <= n <= 9 or len(sen) > 50:
            continue
        low = sen.lower()
        score = (2 if sen.endswith(("!", "?")) else 0) + sum(1 for w in words if re.search(r"(?<!\w)" + re.escape(w) + r"(?!\w)", low))
        if score and (best is None or score > best[0]):
            best = (score, sen[0].upper() + sen[1:])
    if not best:
        return fallback
    who = clean_text(video.get("channel", ""))
    return f"{who} : « {best[1]} »" if who else f"« {best[1]} »"


def make_clip(video: dict, moment: dict, segments, cfg, workdir: Path, data: Path, source=None, title=None) -> dict:
    """source : fichier déjà découpé (tests) ; sinon seul le segment est téléchargé.
    title : titre imposé ("" = aucun) ; None = titre automatique selon render.title."""
    start, end = moment["start"], moment["end"]
    cid = clip_id(video["id"], start)
    src = source or download.download_section(video["id"], start, end, workdir, cfg["render"]["max_source_height"])
    duration = vertical.probe_duration(src) or (end - start)
    r = cfg["render"]
    events = vertical.subtitle_events(segments, start, end, max_words=r.get("subtitle_max_words", 3),
                                      highlight=r.get("subtitle_highlight", True),
                                      upper=r.get("subtitle_uppercase", False)) if r["subtitles"] else []
    if title is None:
        title = hook_title(segments, start, end, video, r.get("title", "auto"), cfg.get("moments"))
    ass_name = f"subs_{cid}.ass"
    (workdir / ass_name).write_text(
        vertical.build_ass(events, f"Source : {video['channel']}", duration, r["font"], title, r.get("layout", "zoom"),
                           r.get("title_style", "encadre")),
        encoding="utf-8")
    out = data / "clips" / f"{cid}.mp4"
    tmp = workdir / f"{cid}.render.mp4"
    vertical.render_vertical(Path(src).resolve(), tmp.resolve(), ass_name, workdir, cfg["render"])
    tmp.replace(out)  # le fichier n'apparaît sur le site qu'une fois complet
    vertical.thumbnail(out, data / "thumbs" / f"{cid}.jpg", duration / 2)
    return {"id": cid, "video_id": video["id"], "video_title": video["title"], "channel": video["channel"],
            "url": video["url"], "start": start, "end": end, "score": moment["score"],
            "created_at": time.time(), "file_size": out.stat().st_size,
            "reasons": json.dumps(moment.get("signals", {})), "hook": title,
            # passage transcrit gardé pour pouvoir refaire le clip (nouveau titre) sans retranscrire
            "segments": json.dumps([s for s in segments if s["end"] > start and s["start"] < end])}


def rerender(db, data: Path, cid: str, cfg, title: str) -> dict:
    """Refait un clip avec un autre titre : retélécharge seulement son segment, garde vu/favori et sa date."""
    c = db.get_clip(cid)
    video = {"id": c["video_id"], "title": c["video_title"], "channel": c["channel"], "url": c["url"]}
    moment = {"start": c["start"], "end": c["end"], "score": c["score"], "signals": json.loads(c.get("reasons") or "{}")}
    workdir = data / "tmp" / f"rerender_{cid}"
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        new = make_clip(video, moment, json.loads(c.get("segments") or "[]"), cfg, workdir, data, title=title)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    new["created_at"] = c["created_at"]
    db.add_clip(new)
    db.set_flag(cid, "seen", c["seen"])
    db.set_flag(cid, "favorite", c["favorite"])
    return new


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
