"""Pipeline complet + suivi de progression + exécution en tâche de fond (un seul job à la fois)."""
import json
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


def read_state(path: Path):
    """État d'un job (lancé par le site ou le terminal). Sans battement depuis 60 s : considéré arrêté."""
    try:
        s = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if s.get("running") and time.time() - s.get("updated_at", 0) > 60:
        s.update(running=False, stage=None, error=s.get("error") or "interrompu")
    return s


class Progress:
    def __init__(self, state_file: Path | None = None):
        self.state_file = state_file
        self._lock = threading.Lock()
        self.state = {"running": False, "stage": None, "stages": STAGES, "video": "", "video_index": 0,
                      "video_total": 0, "detail": "", "clips": 0, "errors": 0, "log": [], "error": None,
                      "started_at": None, "finished_at": None}

    def _save(self):
        if not self.state_file:
            return
        try:
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps({**self.state, "updated_at": time.time()}), encoding="utf-8")
            tmp.replace(self.state_file)
        except OSError:  # lecture concurrente sous Windows : on réessaiera au prochain battement
            pass

    def update(self, **kw):
        with self._lock:
            self.state.update(kw)
            self._save()

    def log(self, msg, level=logging.INFO):
        log.log(level, msg)
        with self._lock:
            self.state["log"] = (self.state["log"] + [time.strftime("%H:%M:%S ") + msg])[-30:]
            self._save()

    def snapshot(self):
        with self._lock:
            return {**self.state, "log": list(self.state["log"])}


def process_video(cand, cfg, db, data, workdir, progress, dry_run=False):
    vid, t_video = cand["id"], time.time()
    progress.update(stage="téléchargement", detail="")
    t = time.time()
    heatmap = cand.get("heatmap")
    if heatmap is None:
        heatmap = download.fetch_info(vid, db).get("heatmap")
    wav = download.download_audio(vid, workdir)
    rms = scoring.audio_rms(wav)
    progress.log(f"Audio récupéré en {time.time() - t:.0f} s")

    progress.update(stage="transcription", detail="")
    t = time.time()
    tcfg, mcfg = cfg["transcription"], cfg["moments"]
    if tcfg.get("check_language"):
        lang, prob = transcribe.detect_language(wav, tcfg, cand["duration"])
        if lang != tcfg["language"] and prob > 0.5:
            raise SkipVideo(f"langue détectée : {lang} ({prob:.0%})")
    regions = None
    if transcribe.mode_of(tcfg)[0]:
        if heatmap:
            # mode rapide : candidats choisis sur heatmap + audio, on ne transcrit que leurs alentours
            mcfg = {**mcfg, "weights": {**mcfg["weights"], "keywords": 0}}
            wins = scoring.candidate_windows(cand["duration"], heatmap, rms, mcfg, int(mcfg["clips_per_video"]) * 2)
            regions = scoring.merge_regions(wins, cand["duration"])
            progress.log(f"Mode rapide : {sum(e - s for s, e in regions) / 60:.1f} min à transcrire "
                         f"sur {cand['duration'] / 60:.1f} min")
        else:
            progress.log("Pas de heatmap : transcription complète (le mode rapide en a besoin)")
    segments = transcribe.transcribe(wav, vid, tcfg, db, regions=regions,
                                     on_progress=lambda p: progress.update(detail=f"transcription {p} %"))
    progress.update(detail="")
    if not segments:
        progress.log("Transcription vide : découpe sur heatmap/audio uniquement", logging.WARNING)
    progress.log(f"Transcription : {len(segments)} segments en {time.time() - t:.0f} s")

    progress.update(stage="découpe")
    if not heatmap:
        progress.log("Pas de heatmap : signaux audio + mots-clés uniquement")
    moments = scoring.select_moments(cand["duration"], segments, heatmap, rms, mcfg)
    moments = scoring.llm_rescore(moments, segments, mcfg, db)
    wav.unlink(missing_ok=True)
    if dry_run:
        return moments

    progress.update(stage="rendu")
    made = []
    for m in moments:
        t = time.time()
        try:
            c = clip.make_clip(cand, m, segments, cfg, workdir, data)
            db.add_clip(c)
            made.append(c)
            progress.update(clips=progress.snapshot()["clips"] + 1)
            progress.log(f"Clip {m['start']:.0f}-{m['end']:.0f} s (score {m['score']:.2f}) "
                         f"téléchargé et rendu en {time.time() - t:.0f} s")
        except Exception as e:
            progress.log(f"Rendu échoué {m['start']:.0f}s : {str(e).splitlines()[-1]}", logging.ERROR)
    progress.log(f"Vidéo traitée en {(time.time() - t_video) / 60:.1f} min")
    return made


def run_pipeline(cfg=None, db=None, progress=None, dry_run=False, url=None, keep_temp=False, check_lock=True):
    cfg = cfg or load_config()
    data = data_dir()
    if check_lock:
        st = read_state(data / "job.json")
        if st and st.get("running"):
            msg = "un traitement tourne déjà (lancé depuis le site ou un autre terminal)"
            log.error(msg)
            return {"videos": 0, "clips": 0, "errors": 0, "planned": [], "fatal": msg}
    db = db or DB(data / "db.sqlite")
    progress = progress or Progress(data / "job.json")
    beat = threading.Event()
    threading.Thread(target=lambda: [progress.update() for _ in iter(lambda: beat.wait(10), True)],
                     daemon=True).start()
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
        beat.set()
        progress.update(running=False, stage=None, finished_at=time.time())
        progress.log(f"Terminé : {summary['clips']} clip(s), {summary['errors']} erreur(s)")
    return summary


class JobManager:
    def __init__(self, db: DB, state_file: Path):
        self.db = db
        self.state_file = state_file
        self.progress = Progress(state_file)
        self._lock = threading.Lock()

    def status(self) -> dict:
        own = self.progress.snapshot()
        if own["running"]:
            return own
        return read_state(self.state_file) or own

    def start(self, url: str | None = None) -> bool:
        ext = read_state(self.state_file)
        if (ext and ext.get("running")) or not self._lock.acquire(blocking=False):
            return False

        def target():
            try:
                run_pipeline(load_config(), self.db, self.progress, url=url, check_lock=False)
            finally:
                self._lock.release()

        self.progress.update(running=True, stage="recherche", log=[])
        threading.Thread(target=target, daemon=True, name="pipeline").start()
        return True
