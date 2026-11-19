"""Pipeline complet + suivi de progression + exécution en tâche de fond (un seul job à la fois)."""
import logging
import shutil
import threading
import time
from pathlib import Path

from . import clip, download, scoring, search, transcribe
from .config import data_dir, load_config
from .db import DB

log = logging.getLogger("gta6")
STAGES = ["recherche", "téléchargement", "transcription", "découpe", "rendu"]


class SkipVideo(Exception):
    pass


class Progress:
    def __init__(self):
        self._lock = threading.Lock()
        self.state = {"running": False, "stage": None, "stages": STAGES, "video": "", "video_index": 0,
                      "video_total": 0, "clips": 0, "errors": 0, "log": [], "error": None,
                      "started_at": None, "finished_at": None}

    def update(self, **kw):
        with self._lock:
            self.state.update(kw)

    def log(self, msg, level=logging.INFO):
        log.log(level, msg)
        with self._lock:
            self.state["log"] = (self.state["log"] + [time.strftime("%H:%M:%S ") + msg])[-30:]

    def snapshot(self):
        with self._lock:
            return {**self.state, "log": list(self.state["log"])}


def process_video(cand, cfg, db, data, workdir, progress, dry_run=False):
    vid, t0 = cand["id"], time.time()
    progress.update(stage="téléchargement")
    heatmap = cand.get("heatmap")
    if heatmap is None:
        heatmap = download.fetch_info(vid, db).get("heatmap")
    wav = download.download_audio(vid, workdir)
    progress.log(f"Audio récupéré ({time.time() - t0:.0f}s)")

    progress.update(stage="transcription")
    tcfg = cfg["transcription"]
    if tcfg.get("check_language"):
        lang, prob = transcribe.detect_language(wav, tcfg, cand["duration"])
        if lang != tcfg["language"] and prob > 0.5:
            raise SkipVideo(f"langue détectée : {lang} ({prob:.0%})")
    segments = transcribe.transcribe(wav, vid, tcfg, db)
    if not segments:
        progress.log("Transcription vide : découpe sur heatmap/audio uniquement", logging.WARNING)
    progress.log(f"Transcription : {len(segments)} segments ({time.time() - t0:.0f}s)")

    progress.update(stage="découpe")
    if not heatmap:
        progress.log("Pas de heatmap : signaux audio + mots-clés uniquement")
    moments = scoring.select_moments(cand["duration"], segments, heatmap, scoring.audio_rms(wav), cfg["moments"])
    moments = scoring.llm_rescore(moments, segments, cfg["moments"], db)
    wav.unlink(missing_ok=True)
    if dry_run:
        return moments

    progress.update(stage="rendu")
    made = []
    for m in moments:
        try:
            c = clip.make_clip(cand, m, segments, cfg, workdir, data)
            db.add_clip(c)
            made.append(c)
            progress.update(clips=progress.snapshot()["clips"] + 1)
            progress.log(f"Clip {c['id']} ({m['start']:.0f}-{m['end']:.0f}s, score {m['score']:.2f})")
        except Exception as e:
            progress.log(f"Rendu échoué {m['start']:.0f}s : {str(e).splitlines()[-1]}", logging.ERROR)
    return made


def run_pipeline(cfg=None, db=None, progress=None, dry_run=False, url=None, keep_temp=False):
    cfg = cfg or load_config()
    data = data_dir()
    db = db or DB(data / "db.sqlite")
    progress = progress or Progress()
    progress.update(running=True, stage="recherche", clips=0, errors=0, error=None, log=[],
                    started_at=time.time(), finished_at=None, video="", video_index=0, video_total=0)
    workdir = data / "tmp" / f"run_{int(time.time())}"
    workdir.mkdir(parents=True, exist_ok=True)
    summary = {"videos": 0, "clips": 0, "errors": 0, "planned": []}
    try:
        download.require_ffmpeg()
        t0 = time.time()
        if url:
            cands = [download.info_to_candidate(download.fetch_info(url, db))]
        else:
            cands = search.search_videos(cfg["search"], db)
        progress.log(f"Recherche : {len(cands)} vidéo(s) retenue(s) ({time.time() - t0:.0f}s)")
        progress.update(video_total=len(cands))
        for i, cand in enumerate(cands, 1):
            progress.update(video=f"{cand['title']} — {cand['channel']}", video_index=i)
            progress.log(f"[{i}/{len(cands)}] {cand['title']} ({cand['channel']})")
            try:
                res = process_video(cand, cfg, db, data, workdir, progress, dry_run)
                summary["videos"] += 1
                if dry_run:
                    summary["planned"].append({"video": cand, "moments": res})
                else:
                    summary["clips"] += len(res)
                    db.upsert_video(cand, "ok")
            except (SkipVideo, download.VideoUnavailable) as e:
                progress.log(f"Ignorée : {e}", logging.WARNING)
                if not dry_run:
                    db.upsert_video(cand, "skipped", str(e))
            except Exception as e:  # une vidéo qui plante n'arrête pas les autres
                summary["errors"] += 1
                progress.update(errors=summary["errors"])
                progress.log(f"Erreur : {str(e).splitlines()[-1] if str(e) else type(e).__name__}", logging.ERROR)
                log.debug("trace", exc_info=True)
                if not dry_run:
                    db.upsert_video(cand, "error", str(e)[:500])
        if not dry_run:
            n = clip.cleanup_disk(db, data, cfg["cleanup"])
            if n:
                progress.log(f"Nettoyage : {n} clip(s) supprimé(s)")
    except Exception as e:
        progress.update(error=str(e))
        progress.log(f"Échec : {e}", logging.ERROR)
        summary["fatal"] = str(e)
    finally:
        if not keep_temp:
            shutil.rmtree(workdir, ignore_errors=True)
        progress.update(running=False, stage=None, finished_at=time.time())
        progress.log(f"Terminé : {summary['clips']} clip(s), {summary['errors']} erreur(s)")
    return summary


class JobManager:
    def __init__(self, db: DB):
        self.db = db
        self.progress = Progress()
        self._lock = threading.Lock()

    def start(self) -> bool:
        if not self._lock.acquire(blocking=False):
            return False

        def target():
            try:
                run_pipeline(load_config(), self.db, self.progress)
            finally:
                self._lock.release()

        self.progress.update(running=True, stage="recherche", log=[])
        threading.Thread(target=target, daemon=True, name="pipeline").start()
        return True
