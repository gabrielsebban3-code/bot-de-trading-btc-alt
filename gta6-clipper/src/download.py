"""Accès YouTube via yt-dlp : métadonnées (en cache), piste audio basse qualité, segments vidéo seuls."""
import logging
import math
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError, download_range_func

log = logging.getLogger(__name__)

BASE_OPTS = {"quiet": True, "no_warnings": True, "noplaylist": True, "noprogress": True}
INFO_KEYS = ("id", "title", "channel", "uploader", "channel_id", "duration", "view_count", "like_count",
             "timestamp", "upload_date", "live_status", "language", "heatmap", "webpage_url")
UNAVAILABLE = ("private", "unavailable", "country", "members-only", "sign in", "removed", "copyright", "age")


class VideoUnavailable(Exception):
    pass


class FFmpegMissing(RuntimeError):
    pass


def require_ffmpeg():
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise FFmpegMissing("ffmpeg/ffprobe introuvable : installe-le (voir README).")


def ffmpeg(*args, cwd=None):
    cmd = ["ffmpeg", "-loglevel", "error", "-hide_banner", "-y", *map(str, args)]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg : " + "\n".join(r.stderr.strip().splitlines()[-20:]))


def video_id(url_or_id: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})", url_or_id or "")
    if m:
        return m.group(1)
    if re.fullmatch(r"[\w-]{11}", url_or_id or ""):
        return url_or_id
    raise ValueError(f"Lien YouTube non reconnu : {url_or_id}")


def watch_url(vid: str) -> str:
    return f"https://www.youtube.com/watch?v={vid}"


def moment_url(vid: str, seconds: float) -> str:
    """Lien vers la vidéo YouTube originale à cet instant."""
    return f"https://youtu.be/{vid}?t={int(seconds)}"


def fetch_info(url_or_id: str, db, max_age_h: float = 24) -> dict:
    vid = video_id(url_or_id)
    cached = db.cache_get("info:" + vid, max_age_h * 3600)
    if cached:
        return cached
    try:
        with YoutubeDL({**BASE_OPTS, "skip_download": True}) as y:
            info = y.extract_info(watch_url(vid), download=False)
    except DownloadError as e:
        if any(w in str(e).lower() for w in UNAVAILABLE):
            raise VideoUnavailable(str(e).splitlines()[0]) from e
        raise
    slim = {k: info.get(k) for k in INFO_KEYS}
    slim["id"] = vid  # Twitch renvoie « v123… » : on garde notre identifiant
    db.cache_set("info:" + vid, slim)
    return slim


def info_to_candidate(info: dict) -> dict:
    ts = info.get("timestamp")
    if ts:
        pub = datetime.fromtimestamp(ts, timezone.utc)
    elif info.get("upload_date"):
        pub = datetime.strptime(info["upload_date"], "%Y%m%d").replace(tzinfo=timezone.utc)
    else:
        pub = None
    return {
        "id": info["id"], "title": info.get("title") or "", "channel": info.get("channel") or info.get("uploader") or "?",
        "url": watch_url(info["id"]), "published_at": pub.isoformat() if pub else None,
        "duration": info.get("duration") or 0, "views": info.get("view_count") or 0, "likes": info.get("like_count") or 0,
        "live": info.get("live_status") in ("is_live", "is_upcoming"), "language": info.get("language"),
        "was_live": info.get("live_status") == "was_live",
        "heatmap": info.get("heatmap"),
    }


def download_audio(vid: str, workdir: Path, section=None) -> Path:
    """Piste audio la plus légère, convertie en WAV mono 16 kHz (Whisper + RMS).
    section=(début, fin) : seulement ce passage (clip à un minutage, streams de plusieurs heures)."""
    workdir.mkdir(parents=True, exist_ok=True)
    opts = {**BASE_OPTS, "format": "bestaudio[abr<=70]/worstaudio/bestaudio",
            "outtmpl": str(workdir / f"{vid}_audio.%(ext)s")}
    if section:
        opts.update({"download_ranges": download_range_func(None, [tuple(section)]), "force_keyframes_at_cuts": True})
    try:
        with YoutubeDL(opts) as y:
            y.download([watch_url(vid)])
    except DownloadError as e:
        if any(w in str(e).lower() for w in UNAVAILABLE):
            raise VideoUnavailable(str(e).splitlines()[0]) from e
        raise
    src = next(p for p in workdir.glob(f"{vid}_audio.*") if p.suffix != ".wav")
    wav = workdir / f"{vid}.wav"
    ffmpeg("-i", src, "-ac", 1, "-ar", 16000, "-c:a", "pcm_s16le", wav)
    src.unlink(missing_ok=True)
    return wav


def download_section(vid: str, start: float, end: float, workdir: Path, max_height: int = 1080) -> Path:
    """Télécharge uniquement [start, end] (coupe précise : force_keyframes_at_cuts)."""
    stem = f"{vid}_{int(start * 10)}"
    h = int(max_height)
    opts = {**BASE_OPTS,
            "format": f"bv*[height<={h}][vcodec^=avc1]+ba[acodec^=mp4a]/bv*[height<={h}]+ba/b[height<={h}]/b",
            "outtmpl": str(workdir / f"{stem}.%(ext)s"),
            "download_ranges": download_range_func(None, [(start, end)]),
            "force_keyframes_at_cuts": True, "merge_output_format": "mp4",
            # yt-dlp réencode le segment pour couper juste : rapide et quasi sans perte (réencodé ensuite)
            "external_downloader_args": {"ffmpeg_o": ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "16",
                                                      "-c:a", "aac", "-b:a", "192k"]}}
    with YoutubeDL(opts) as y:
        y.download([watch_url(vid)])
    return next(workdir.glob(f"{stem}.*"))


STAMP = re.compile(r"(?<![\d:])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?![\d:])")


def parse_stamps(comments, duration):
    """[(seconde, poids)] : chaque instant cité dans un commentaire, pondéré par ses likes."""
    out = []
    for c in comments or []:
        found = set()
        for h, m, s in STAMP.findall(c.get("text") or ""):
            t = int(h or 0) * 3600 + int(m) * 60 + int(s)
            if 0 < t < duration:
                found.add(t)
        out += [(t, 1.0 + math.log1p(c.get("like_count") or 0)) for t in found]
    return out


def fetch_comment_stamps(vid, db, duration, max_comments=100):
    """Lit les commentaires les plus populaires (yt-dlp) et en extrait les horodatages. None si impossible."""
    key = f"comments:{vid}"
    comments = db.cache_get(key, 12 * 3600)
    if comments is None:
        opts = {**BASE_OPTS, "skip_download": True, "getcomments": True,
                "extractor_args": {"youtube": {"max_comments": [str(max_comments), str(max_comments), "0", "0"],
                                               "comment_sort": ["top"]}}}
        try:
            with YoutubeDL(opts) as y:
                info = y.extract_info(watch_url(vid), download=False)
        except Exception as e:
            log.warning("Commentaires indisponibles : %s", str(e).splitlines()[0])
            return None
        comments = [{"text": c.get("text"), "like_count": c.get("like_count")} for c in info.get("comments") or []]
        db.cache_set(key, comments)
    return parse_stamps(comments, duration)


def parse_time(value):
    """« 41:20 », « 1:02:03 », « 2480 », « 2480s », « 41m20s » -> secondes ; None si illisible."""
    v = str(value or "").strip().lower()
    if not v:
        return None
    if re.fullmatch(r"\d+(\.\d+)?s?", v):
        return float(v.rstrip("s"))
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", v)
    if m:
        return float(int(m[1] or 0) * 3600 + int(m[2]) * 60 + int(m[3]))
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?", v)
    if m and any(m.groups()):
        return float(int(m[1] or 0) * 3600 + int(m[2] or 0) * 60 + int(m[3] or 0))
    return None


def url_time(url):
    """Minutage d'un lien « partager à partir de » (…?t=2480 ou &t=41m20s)."""
    m = re.search(r"[?&#](?:t|start)=([\dhms.]+)", url or "")
    return parse_time(m.group(1)) if m else None


# --- chat des rediffusions de lives YouTube (le signal de heistclips, en local) ---
CHAT_FUN = re.compile(r"(?<!\w)(mdr+|ptdr+|x+d+|a?h+a+h+a*\w*|clip+|omg|wtf|ptn|gg+|oh+|no+n+)(?!\w)")
CHAT_FUN_EMOJI = ("😂", "🤣", "💀", "face_with_tears_of_joy", "rolling_on_the_floor_laughing", "skull")
CHAT_TIME = re.compile(r'"videoOffsetTimeMsec"\s*:\s*"(\d+)"')
CHAT_TEXT = re.compile(r'"text"\s*:\s*"((?:[^"\\]|\\.)*)"')


def parse_live_chat(lines, duration):
    """Fichier live_chat.json de yt-dlp (une action par ligne) -> messages et réactions (« mdr », 😂…) par seconde."""
    n = int(math.ceil(duration))
    msgs, fun = [0] * n, [0] * n
    for line in lines:
        m = CHAT_TIME.search(line)
        if not m or "addChatItemAction" not in line:
            continue
        t = int(m.group(1)) // 1000
        if not 0 <= t < n:
            continue
        msgs[t] += 1
        text = " ".join(CHAT_TEXT.findall(line)).lower()
        if CHAT_FUN.search(text) or any(e in line for e in CHAT_FUN_EMOJI):
            fun[t] += 1
    return msgs, fun


def fetch_chat_counts(vid, db, duration, workdir: Path):
    """Chat d'une rediffusion de live YouTube, réduit à des comptes par seconde (mis en cache). None si absent."""
    key = f"chat:{vid}"
    cached = db.cache_get(key)
    if cached is not None:
        return cached or None
    opts = {**BASE_OPTS, "skip_download": True, "writesubtitles": True, "subtitleslangs": ["live_chat"],
            "outtmpl": str(workdir / f"{vid}_chat.%(ext)s")}
    try:
        with YoutubeDL(opts) as y:
            y.download([watch_url(vid)])
    except Exception as e:
        log.warning("Chat du live indisponible : %s", str(e).splitlines()[0])
        return None
    f = next(workdir.glob(f"{vid}_chat*.json"), None)
    if not f:
        db.cache_set(key, {})
        return None
    with open(f, encoding="utf-8", errors="ignore") as fh:
        msgs, fun = parse_live_chat(fh, duration)
    f.unlink(missing_ok=True)
    out = {"messages": msgs, "reactions": fun} if any(msgs) else {}
    db.cache_set(key, out)
    return out or None
