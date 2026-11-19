"""Accès YouTube via yt-dlp : métadonnées (en cache), piste audio basse qualité, segments vidéo seuls."""
import logging
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
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([\w-]{11})", url_or_id)
    if m:
        return m.group(1)
    if re.fullmatch(r"[\w-]{11}", url_or_id):
        return url_or_id
    raise ValueError(f"URL YouTube invalide : {url_or_id}")


def watch_url(vid: str) -> str:
    return f"https://www.youtube.com/watch?v={vid}"


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
        "heatmap": info.get("heatmap"),
    }


def download_audio(vid: str, workdir: Path) -> Path:
    """Piste audio la plus légère, convertie en WAV mono 16 kHz (Whisper + RMS)."""
    workdir.mkdir(parents=True, exist_ok=True)
    opts = {**BASE_OPTS, "format": "bestaudio[abr<=70]/worstaudio/bestaudio",
            "outtmpl": str(workdir / f"{vid}_audio.%(ext)s")}
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
