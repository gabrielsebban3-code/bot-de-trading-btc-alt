"""Site privé local : FastAPI + Jinja2 + JS vanilla. Aucun asset externe."""
import hmac
import json
import secrets
import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .. import clip as cliplib
from ..download import parse_time, video_id
from ..scoring import learn_weights
from ..config import data_dir, load_config, save_config
from ..db import DB
from ..jobs import JobManager

HERE = Path(__file__).parent
COOKIE = "gta6_session"
SESSION_DAYS = 30
CSP = ("default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self'; script-src 'self'; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


def human_size(n: float) -> str:
    for unit in ("o", "Ko", "Mo", "Go"):
        if n < 1024 or unit == "Go":
            return f"{n:.0f} {unit}" if unit in ("o", "Ko") else f"{n:.1f} {unit}"
        n /= 1024


def _secret(data: Path) -> str:
    p = data / "secret.key"
    if not p.exists():
        p.write_text(secrets.token_hex(32))
        p.chmod(0o600)
    return p.read_text().strip()


def _lines(text: str):
    return [x.strip() for x in text.splitlines() if x.strip()]


def _int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return default


REASON_LABELS = {"manuel": "choisi à la main", "heatmap": "très revu", "comments": "cité en commentaire", "audio": "voix qui s'emballe",
                 "keywords": "mots forts", "parole": "parole", "llm": "note IA"}


def why(reasons) -> str:
    try:
        r = json.loads(reasons or "{}")
    except ValueError:
        return ""
    return " · ".join(f"{label} {r[k]:.0%}" for k, label in REASON_LABELS.items() if k in r)


DURATIONS = {"long": (60, 90, 70), "moyen": (35, 60, 48), "court": (20, 45, 32)}


def duration_preset(m: dict) -> str:
    cur = (m["min_clip_s"], m["max_clip_s"])
    return next((k for k, v in DURATIONS.items() if v[:2] == cur), "perso")


def clip_view(c: dict) -> dict:
    return {**c, "duration": round(c["end"] - c["start"]), "why": why(c.get("reasons")),
            "yt": f"https://youtu.be/{c['video_id']}?t={int(c['start'])}",
            "date": datetime.fromtimestamp(c["created_at"]).strftime("%d/%m %H:%M")}


def create_app(require_auth: bool = False, password: str | None = None, data: Path | None = None,
               db: DB | None = None, jobs: JobManager | None = None) -> FastAPI:
    if require_auth and not password:
        raise ValueError("Mot de passe obligatoire quand l'authentification est requise")
    data = data or data_dir()
    db = db or DB(data / "db.sqlite")
    jobs = jobs or JobManager(db, data / "job.json")
    signer = URLSafeTimedSerializer(_secret(data) + (password or ""), salt="gta6-login")

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.db, app.state.jobs, app.state.data = db, jobs, data
    tpl = Jinja2Templates(directory=str(HERE / "templates"))
    app.mount("/static", StaticFiles(directory=str(HERE / "static")), name="static")

    def logged_in(request: Request) -> bool:
        tok = request.cookies.get(COOKIE)
        if not tok:
            return False
        try:
            signer.loads(tok, max_age=SESSION_DAYS * 86400)
            return True
        except BadSignature:
            return False

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if require_auth and path != "/login" and not path.startswith("/static/") and not logged_in(request):
            if path.startswith("/api/") or request.method != "GET":
                resp = JSONResponse({"error": "non authentifié"}, status_code=401)
            else:
                resp = RedirectResponse("/login", status_code=303)
        else:
            resp = await call_next(request)
        resp.headers["Content-Security-Policy"] = CSP
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        return resp

    def page(request, name, status=200, **ctx):
        footer = None if name == "login.html" else {"disk": human_size(cliplib.disk_usage(data)), **db.counts()}
        return tpl.TemplateResponse(request, name, {"auth": require_auth, "footer": footer, **ctx}, status_code=status)

    def get_clip_or_404(cid):
        c = db.get_clip(cid)
        if not c:
            raise HTTPException(404, "clip introuvable")
        return c

    # --- auth ---
    @app.get("/login")
    def login_form(request: Request):
        return page(request, "login.html", error=None)

    @app.post("/login")
    def login(request: Request, password_in: str = Form("", alias="password")):
        if require_auth and hmac.compare_digest(password_in.encode(), (password or "").encode()):
            resp = RedirectResponse("/", status_code=303)
            resp.set_cookie(COOKIE, signer.dumps("ok"), max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")
            return resp
        time.sleep(1)  # freine le bruteforce
        return page(request, "login.html", error="Mot de passe incorrect", status=401)

    @app.post("/logout")
    def logout():
        resp = RedirectResponse("/login", status_code=303)
        resp.delete_cookie(COOKIE)
        return resp

    # --- pages ---
    @app.get("/")
    def index(request: Request, show: str = "all", video: str = "", channel: str = "", sort: str = "date"):
        clips = [clip_view(c) for c in db.list_clips(show, video or None, channel or None, sort)]
        videos, channels = db.facets()
        js = [{k: c.get(k) for k in ("id", "video_title", "channel", "duration", "score", "favorite", "seen", "yt", "why",
                                      "hook", "file_size", "rating")}
              for c in clips]
        return page(request, "index.html", clips=clips, clips_js=js, videos=videos, channels=channels,
                    f={"show": show, "video": video, "channel": channel, "sort": sort}, job=jobs.status())

    @app.get("/videos")
    def videos_page(request: Request):
        vids = db.list_videos()
        counts = {}
        for c in db.list_clips():
            counts[c["video_id"]] = counts.get(c["video_id"], 0) + 1
        for v in vids:
            v["clips"] = counts.get(v["id"], 0)
            v["date"] = datetime.fromtimestamp(v["processed_at"]).strftime("%d/%m %H:%M") if v["processed_at"] else ""
        return page(request, "videos.html", videos=vids)

    @app.get("/settings")
    def settings_form(request: Request, saved: int = 0):
        cfg = load_config()
        rated = db.rated_signals()
        weights, learned = learn_weights(rated, cfg["moments"]["weights"])
        learning = {"good": sum(1 for r, _ in rated if r > 0), "bad": sum(1 for r, _ in rated if r < 0),
                    "learned": learned and cfg["moments"].get("learn_from_ratings", True),
                    "weights": weights, "base": cfg["moments"]["weights"]}
        return page(request, "settings.html", cfg=cfg, saved=saved, duration=duration_preset(cfg["moments"]),
                    learning=learning)

    @app.post("/settings")
    async def settings_save(request: Request):
        form = await request.form()
        cfg = load_config()
        s, m = cfg["search"], cfg["moments"]
        s["queries"] = _lines(form.get("queries", "")) or s["queries"]
        s["top_n"] = _int(form.get("top_n"), 1, 50, s["top_n"])
        s["days"] = _int(form.get("days"), 1, 365, s["days"])
        s["min_views"] = _int(form.get("min_views"), 0, 10 ** 9, s["min_views"])
        s["channel_whitelist"] = _lines(form.get("whitelist", ""))
        s["channel_blacklist"] = _lines(form.get("blacklist", ""))
        m["clips_per_video"] = _int(form.get("clips_per_video"), 1, 10, m["clips_per_video"])
        if form.get("tmode") in ("complete", "rapide", "tres_rapide"):
            cfg["transcription"]["mode"] = form.get("tmode")
        if form.get("title_style") in ("encadre", "texte"):
            cfg["render"]["title_style"] = form.get("title_style")
        if form.get("layout") in ("zoom", "noir", "flou"):
            cfg["render"]["layout"] = form.get("layout")
        if form.get("title") in ("auto", "video", "none"):
            cfg["render"]["title"] = form.get("title")
        if form.get("duration") in DURATIONS:
            m["min_clip_s"], m["max_clip_s"], m["target_clip_s"] = DURATIONS[form.get("duration")]
        cfg["render"]["subtitles"] = form.get("subtitles") == "on"
        cfg["render"]["subtitle_highlight"] = form.get("highlight") == "on"
        cfg["render"]["subtitle_uppercase"] = form.get("uppercase") == "on"
        cfg["cleanup"]["max_age_days"] = _int(form.get("max_age_days"), 1, 3650, cfg["cleanup"]["max_age_days"])
        cfg["cleanup"]["max_total_gb"] = _int(form.get("max_total_gb"), 1, 10000, cfg["cleanup"]["max_total_gb"])
        save_config(cfg)
        return RedirectResponse("/settings?saved=1", status_code=303)

    # --- fichiers (Range géré par FileResponse) ---
    @app.get("/media/{cid}.mp4")
    def media(cid: str):
        get_clip_or_404(cid)
        path = cliplib.clip_paths(data, cid)[0]
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path, media_type="video/mp4")

    @app.get("/thumbs/{cid}.jpg")
    def thumb(cid: str):
        get_clip_or_404(cid)
        path = cliplib.clip_paths(data, cid)[1]
        if not path.exists():
            raise HTTPException(404)
        return FileResponse(path, media_type="image/jpeg")

    @app.get("/download/{cid}")
    def download(cid: str):
        get_clip_or_404(cid)
        return FileResponse(cliplib.clip_paths(data, cid)[0], media_type="video/mp4", filename=f"{cid}.mp4")

    # --- API ---
    @app.post("/api/clips/{cid}/seen")
    def seen(cid: str):
        get_clip_or_404(cid)
        db.set_flag(cid, "seen", 1)
        return {"seen": 1}

    @app.post("/api/clips/{cid}/favorite")
    def favorite(cid: str):
        c = get_clip_or_404(cid)
        v = 0 if c["favorite"] else 1
        db.set_flag(cid, "favorite", v)
        return {"favorite": v}

    @app.post("/api/clips/{cid}/rate")
    async def rate(cid: str, request: Request):
        c = get_clip_or_404(cid)
        try:
            value = int((await request.form()).get("value", 0))
        except ValueError:
            value = 0
        value = max(-1, min(1, value))
        value = 0 if value == (c.get("rating") or 0) else value  # recliquer annule la note
        db.set_flag(cid, "rating", value)
        return {"rating": value}

    @app.delete("/api/clips/{cid}")
    def delete(cid: str):
        get_clip_or_404(cid)
        cliplib.remove_clip(db, data, cid)
        return {"deleted": cid}

    @app.post("/api/clips/{cid}/hook")
    async def set_hook(cid: str, request: Request):
        get_clip_or_404(cid)
        title = str((await request.form()).get("hook") or "").strip()[:120]
        try:
            await run_in_threadpool(cliplib.rerender, db, data, cid, load_config(), title)
        except Exception as e:
            msg = str(e).splitlines()[-1][:200] if str(e) else type(e).__name__
            return JSONResponse({"ok": False, "error": msg}, status_code=500)
        return {"ok": True}

    @app.post("/api/run")
    async def run(request: Request):
        form = await request.form()
        url = str(form.get("url") or "").strip()
        at_raw = str(form.get("at") or "").strip()
        at = parse_time(at_raw) if at_raw else None
        if at_raw and at is None:
            return JSONResponse({"started": False, "error": "minutage illisible (exemple : 41:20)"}, status_code=400)
        if at is not None and not url:
            return JSONResponse({"started": False, "error": "colle aussi le lien de la vidéo"}, status_code=400)
        if url:
            try:
                video_id(url)
            except ValueError:
                return JSONResponse({"started": False, "error": "lien YouTube invalide"}, status_code=400)
        if not jobs.start(url or None, at):
            return JSONResponse({"started": False, "error": "un traitement tourne déjà"}, status_code=409)
        return {"started": True}

    @app.post("/api/cancel")
    def cancel():
        if not jobs.status().get("running"):
            return JSONResponse({"cancelling": False, "error": "aucun traitement en cours"}, status_code=409)
        (data / "cancel").write_text("1")  # lu par le pipeline, qu'il tourne ici ou dans un terminal
        return {"cancelling": True}

    @app.get("/api/job")
    def job():
        return jobs.status()

    return app
