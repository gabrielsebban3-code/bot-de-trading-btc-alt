"""CLI : gta6-clipper run | serve | status"""
import argparse
import logging
import os
import sys

from .config import data_dir, load_config, load_env


def _fmt(t):
    return f"{int(t // 60)}:{t % 60:04.1f}"


def cmd_run(args):
    from .jobs import run_pipeline

    from .download import parse_time
    at = parse_time(args.at) if args.at else None
    if args.at and (at is None or not args.url):
        print("--at demande un minutage lisible (ex. 41:20) et --url", file=sys.stderr)
        return 2
    summary = run_pipeline(load_config(), dry_run=args.dry_run, url=args.url, keep_temp=args.keep_temp, at=at)
    if args.dry_run:
        for p in summary["planned"]:
            v = p["video"]
            print(f"\n{v['title']} — {v['channel']}\n  {v['url']}")
            for m in p["moments"]:
                sig = " ".join(f"{k}={x:.2f}" for k, x in m["signals"].items())
                print(f"  {_fmt(m['start'])} → {_fmt(m['end'])} ({m['end'] - m['start']:.0f}s) "
                      f"score={m['score']:.2f} {'' if m['aligned'] else '[non aligné] '}{sig}")
    else:
        print(f"{summary['videos']} vidéo(s), {summary['clips']} clip(s), {summary['errors']} erreur(s)")
    return 1 if summary.get("fatal") else 0


def cmd_serve(args):
    import uvicorn

    from .web.app import create_app

    password = os.environ.get("SITE_PASSWORD")
    if args.lan and not password:
        print("Refus : --lan exige SITE_PASSWORD dans .env (le site serait ouvert à tout le réseau).", file=sys.stderr)
        return 2
    host = "0.0.0.0" if args.lan else "127.0.0.1"
    app = create_app(require_auth=args.lan, password=password if args.lan else None)
    print(f"Site : http://127.0.0.1:{args.port}" + ("  (réseau local, mot de passe requis)" if args.lan else ""))
    uvicorn.run(app, host=host, port=args.port, log_level="warning")
    return 0


def cmd_status(_args):
    from .clip import disk_usage
    from .db import DB
    from .web.app import human_size

    data = data_dir()
    db = DB(data / "db.sqlite")
    c = db.counts()
    print(f"{c['videos']} vidéos traitées · {c['clips']} clips ({c['unseen']} non vus, {c['favorites']} favoris) · "
          f"{human_size(disk_usage(data))}")
    for v in db.list_videos()[:30]:
        n = len(db.list_clips(video=v["id"]))
        err = f" — {v['error'][:80]}" if v["error"] else ""
        print(f"  [{v['status']:7}] {n} clip(s)  {v['title'][:70]} ({v['channel']}){err}")
    return 0


def ytdlp_age_days(version: str, today=None):
    """Âge en jours d'une version de yt-dlp (« 2026.10.26 ») ; None si illisible."""
    import datetime as dt
    try:
        y, m, d = (int(x) for x in version.split(".")[:3])
        return ((today or dt.date.today()) - dt.date(y, m, d)).days
    except (ValueError, TypeError):
        return None


def cmd_doctor(_args):
    """Vérifie l'installation. Sortie ASCII pour la console Windows."""
    import platform
    import shutil
    import socket
    import subprocess
    from pathlib import Path

    failed = []

    def check(name, fn, info_only=False):
        try:
            detail = fn()
            print(f"[OK]    {name}" + (f" : {detail}" if detail else ""))
        except Exception as e:
            msg = str(e).splitlines()[0][:200] if str(e) else type(e).__name__
            print(f"[{'INFO' if info_only else 'ECHEC'}]  {name} : {msg}")
            if not info_only:
                failed.append(name)

    def py():
        if sys.version_info < (3, 11):
            raise RuntimeError(f"{platform.python_version()} : il faut Python 3.11 ou plus")
        return platform.python_version()

    def ff():
        from .download import require_ffmpeg
        require_ffmpeg()
        filt = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True).stdout
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        missing = [n for n, ok in (("subtitles (libass)", " subtitles " in filt), ("libx264", "libx264" in enc)) if not ok]
        if missing:
            raise RuntimeError("ffmpeg sans " + ", ".join(missing))
        return "subtitles + libx264 disponibles"

    def libs():
        import av
        import faster_whisper
        import yt_dlp
        return f"yt-dlp {yt_dlp.version.__version__}, faster-whisper {faster_whisper.__version__}, av {av.__version__}"

    def yt():
        from yt_dlp import YoutubeDL
        from .download import BASE_OPTS
        from .search import search_url
        with YoutubeDL({**BASE_OPTS, "extract_flat": "in_playlist", "skip_download": True, "playlistend": 3}) as y:
            res = y.extract_info(search_url("GTA 6", 7), download=False)
        n = len([e for e in res.get("entries", []) if e])
        if not n:
            raise RuntimeError("la recherche ne renvoie aucune vidéo")
        return f"{n} résultat(s) pour 'GTA 6'"

    def model():
        name = load_config()["transcription"]["model"]
        hub = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub"
        if (hub / f"models--Systran--faster-whisper-{name}").exists():
            return f"'{name}' déjà téléchargé"
        raise RuntimeError(f"'{name}' pas encore téléchargé (fait automatiquement au premier traitement)")

    def disk():
        d = data_dir()
        (d / ".write_test").write_text("ok")
        (d / ".write_test").unlink()
        return f"{d} ({shutil.disk_usage(d).free / 1024 ** 3:.0f} Go libres)"

    def port():
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", 8000))
            except OSError:
                raise RuntimeError("port 8000 occupé : le site tourne déjà ? (sinon : serve --port 8001)")
        return "port 8000 libre"

    print("Diagnostic gta6-clipper\n")
    check("Python", py)
    check("ffmpeg", ff)
    check("Bibliothèques", libs)

    def ytdlp_fresh():
        import yt_dlp
        age = ytdlp_age_days(yt_dlp.version.__version__)
        if age is not None and age > 60:
            raise RuntimeError(f"yt-dlp a {age} jours : lance maj.bat (YouTube change souvent, les vieilles versions cassent)")
        return f"version de moins de 2 mois" if age is not None else "version inconnue"

    check("yt-dlp à jour", ytdlp_fresh)
    check("Recherche YouTube", yt)
    check("Dossier data", disk)
    check("Modèle Whisper", model, info_only=True)
    check("Site", port, info_only=True)
    check("Clé YouTube API", lambda: "présente" if os.environ.get("YOUTUBE_API_KEY") else
          (_ for _ in ()).throw(RuntimeError("absente (facultative : recherche via yt-dlp)")), info_only=True)
    print("\n" + ("Tout est bon." if not failed else "Problème(s) : " + ", ".join(failed)))
    return 1 if failed else 0


def cmd_music(args):
    from .download import import_music, is_playlist_url
    if not is_playlist_url(args.url):
        print("Il faut un lien de playlist YouTube (contenant « list= »).", file=sys.stderr)
        return 2
    n = import_music(args.url, data_dir() / "music", args.max)
    print(f"{n} musique(s) dans {data_dir() / 'music'}")
    return 0


def cli(argv=None):
    for stream in (sys.stdout, sys.stderr):  # évite les plantages d'encodage de la console Windows
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    for noisy in ("faster_whisper", "httpx", "httpx2", "httpcore", "huggingface_hub", "urllib3", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="gta6-clipper", description="Clips verticaux privés à partir de vidéos FR sur GTA 6")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="exécute le pipeline une fois")
    r.add_argument("--dry-run", action="store_true", help="analyse seulement (audio), aucun téléchargement vidéo")
    r.add_argument("--url", help="traite une seule vidéo")
    r.add_argument("--at", help="avec --url : un seul clip autour de ce minutage (ex. 41:20)")
    r.add_argument("--keep-temp", action="store_true", help="garde le dossier temporaire (debug)")
    s = sub.add_parser("serve", help="lance le site privé")
    s.add_argument("--lan", action="store_true", help="écoute sur 0.0.0.0 (mot de passe obligatoire)")
    s.add_argument("--port", type=int, default=8000)
    sub.add_parser("status", help="vidéos et clips déjà traités")
    sub.add_parser("doctor", help="vérifie l'installation (ffmpeg, recherche YouTube, bibliothèques...)")
    mu = sub.add_parser("music", help="importe une playlist YouTube de musiques libres de droits dans data/music")
    mu.add_argument("url")
    mu.add_argument("--max", type=int, default=25)
    args = p.parse_args(argv)
    return {"run": cmd_run, "serve": cmd_serve, "status": cmd_status, "doctor": cmd_doctor,
            "music": cmd_music}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(cli())
