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

    summary = run_pipeline(load_config(), dry_run=args.dry_run, url=args.url, keep_temp=args.keep_temp)
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


def cli(argv=None):
    load_env()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("faster_whisper", "httpx", "uvicorn.access"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    p = argparse.ArgumentParser(prog="gta6-clipper", description="Clips verticaux privés à partir de vidéos FR sur GTA 6")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="exécute le pipeline une fois")
    r.add_argument("--dry-run", action="store_true", help="analyse seulement (audio), aucun téléchargement vidéo")
    r.add_argument("--url", help="traite une seule vidéo")
    r.add_argument("--keep-temp", action="store_true", help="garde le dossier temporaire (debug)")
    s = sub.add_parser("serve", help="lance le site privé")
    s.add_argument("--lan", action="store_true", help="écoute sur 0.0.0.0 (mot de passe obligatoire)")
    s.add_argument("--port", type=int, default=8000)
    sub.add_parser("status", help="vidéos et clips déjà traités")
    args = p.parse_args(argv)
    return {"run": cmd_run, "serve": cmd_serve, "status": cmd_status}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(cli())
