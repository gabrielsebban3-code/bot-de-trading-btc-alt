import time

import pytest
from fastapi.testclient import TestClient

from src import config
from src.db import DB
from src.main import cli
from src.web.app import create_app


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ROOT", tmp_path)
    data = tmp_path / "data"
    for sub in ("clips", "thumbs"):
        (data / sub).mkdir(parents=True)
    db = DB(data / "db.sqlite")
    for i, (seen, fav) in enumerate([(0, 0), (1, 1)]):
        cid = f"abcdefghijk_{i * 100}"
        (data / "clips" / f"{cid}.mp4").write_bytes(bytes(range(256)) * 40)
        (data / "thumbs" / f"{cid}.jpg").write_bytes(b"\xff\xd8jpg")
        db.add_clip({"id": cid, "video_id": "abcdefghijk", "video_title": f"Vidéo {i}", "channel": "Chaîne",
                     "url": "https://www.youtube.com/watch?v=abcdefghijk", "start": i * 100, "end": i * 100 + 30,
                     "score": 0.5 + i / 10, "created_at": time.time(), "file_size": 10240})
        db.set_flag(cid, "seen", seen)
        db.set_flag(cid, "favorite", fav)
    return data, db


def client(env, **kw):
    data, db = env
    return TestClient(create_app(data=data, db=db, **kw))


def test_list_and_filters(env):
    c = client(env)
    r = c.get("/")
    assert r.status_code == 200 and "Vidéo 0" in r.text and "Vidéo 1" in r.text
    assert "youtu.be/abcdefghijk?t=100" in r.text
    assert "Content-Security-Policy" in r.headers
    assert 'data-id="abcdefghijk_100"' not in c.get("/?show=unseen").text
    assert 'data-id="abcdefghijk_0"' not in c.get("/?show=fav").text


def test_range_streaming(env):
    r = client(env).get("/media/abcdefghijk_0.mp4", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100


def test_favorite_seen_delete(env):
    data, db = env
    c = client(env)
    assert c.post("/api/clips/abcdefghijk_0/favorite").json() == {"favorite": 1}
    assert c.post("/api/clips/abcdefghijk_0/favorite").json() == {"favorite": 0}
    c.post("/api/clips/abcdefghijk_0/seen")
    assert db.get_clip("abcdefghijk_0")["seen"] == 1
    assert c.delete("/api/clips/abcdefghijk_0").status_code == 200
    assert db.get_clip("abcdefghijk_0") is None and not (data / "clips" / "abcdefghijk_0.mp4").exists()
    assert c.delete("/api/clips/abcdefghijk_0").status_code == 404
    assert c.get("/media/..%2Fdb.sqlite.mp4").status_code == 404


def test_login_required_in_lan_mode(env):
    c = client(env, require_auth=True, password="secret")
    r = c.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login"
    assert c.post("/api/clips/abcdefghijk_0/favorite").status_code == 401
    assert c.get("/media/abcdefghijk_0.mp4", follow_redirects=False).status_code == 303
    assert c.post("/login", data={"password": "mauvais"}).status_code == 401
    r = c.post("/login", data={"password": "secret"}, follow_redirects=False)
    assert r.status_code == 303 and "gta6_session" in r.cookies
    assert c.get("/").status_code == 200
    c.cookies.set("gta6_session", "forged.token")
    assert c.get("/", follow_redirects=False).status_code == 303


def test_lan_refuses_without_password(monkeypatch):
    monkeypatch.delenv("SITE_PASSWORD", raising=False)
    monkeypatch.setattr("src.main.load_env", lambda: None)
    assert cli(["serve", "--lan"]) == 2
    with pytest.raises(ValueError):
        create_app(require_auth=True, password=None)


def test_settings_save(env):
    c = client(env)
    r = c.post("/settings", data={"queries": "GTA 6\nGTA 6 map\n", "top_n": "3", "clips_per_video": "2",
                                  "days": "5", "min_views": "1000", "blacklist": "Spam", "whitelist": ""})
    assert r.status_code == 200
    cfg = config.load_config()
    assert cfg["search"]["queries"] == ["GTA 6", "GTA 6 map"] and cfg["search"]["top_n"] == 3
    assert cfg["moments"]["clips_per_video"] == 2 and cfg["render"]["subtitles"] is False
    assert cfg["search"]["channel_blacklist"] == ["Spam"]


def test_job_endpoint(env):
    c = client(env)
    j = c.get("/api/job").json()
    assert j["running"] is False and "recherche" in j["stages"]


def test_videos_page_and_run_validation(env):
    data, db = env
    db.upsert_video({"id": "abcdefghijk", "title": "Ma vidéo", "channel": "Chaîne",
                     "url": "https://www.youtube.com/watch?v=abcdefghijk"}, "error", "boom")
    c = client(env)
    r = c.get("/videos")
    assert r.status_code == 200 and "Ma vidéo" in r.text and "boom" in r.text and "2 clip(s)" in r.text
    assert c.post("/api/run", data={"url": "pas un lien"}).status_code == 400


def test_external_job_state_visible_and_blocks_start(env):
    import json
    from src.jobs import read_state
    data, _ = env
    state = {"running": True, "stage": "transcription", "stages": [], "clips": 1, "log": [], "updated_at": time.time()}
    (data / "job.json").write_text(json.dumps(state))
    c = client(env)
    assert c.get("/api/job").json()["stage"] == "transcription"
    assert c.post("/api/run").status_code == 409
    state["updated_at"] = time.time() - 120
    (data / "job.json").write_text(json.dumps(state))
    assert read_state(data / "job.json")["running"] is False


def test_cancel_endpoint(env):
    import json
    data, _ = env
    c = client(env)
    assert c.post("/api/cancel").status_code == 409            # rien ne tourne
    (data / "job.json").write_text(json.dumps({"running": True, "stages": [], "log": [], "updated_at": time.time()}))
    assert c.post("/api/cancel").json() == {"cancelling": True}
    assert (data / "cancel").exists()


def test_pipeline_stops_on_cancel_and_keeps_video_unmarked(tmp_path, monkeypatch):
    from src import jobs
    from src.config import DEFAULTS
    db = DB(tmp_path / "db.sqlite")
    monkeypatch.setattr(jobs, "data_dir", lambda: tmp_path)
    vids = [{"id": f"vid0000000{i}", "title": f"V{i}", "channel": "C", "duration": 300} for i in (1, 2)]
    monkeypatch.setattr(jobs.search, "search_videos", lambda scfg, db: vids)
    seen = []

    def fake_process(cand, cfg, db, data, workdir, progress, dry_run=False):
        seen.append(cand["id"])
        jobs.cancel_file(data).write_text("1")      # l'utilisateur clique sur Annuler pendant la 1re vidéo
        jobs.check_cancel(data, progress)

    monkeypatch.setattr(jobs, "process_video", fake_process)
    res = jobs.run_pipeline(DEFAULTS, db=db)
    assert res.get("cancelled") and seen == ["vid00000001"]
    assert db.list_videos() == []                   # ni « erreur » ni « traitée » : on pourra la relancer
    assert not jobs.cancel_file(tmp_path).exists()  # la demande ne bloque pas le prochain traitement
    assert jobs.read_state(tmp_path / "job.json")["running"] is False


def test_hook_endpoint_rerenders(env, monkeypatch):
    from src import clip as cliplib
    calls = []
    monkeypatch.setattr(cliplib, "rerender", lambda db, data, cid, cfg, title: calls.append((cid, title)))
    c = client(env)
    assert c.post("/api/clips/abcdefghijk_0/hook", data={"hook": "LaSalle est déçu !"}).json() == {"ok": True}
    assert calls == [("abcdefghijk_0", "LaSalle est déçu !")]
    assert c.post("/api/clips/inconnu/hook", data={"hook": "x"}).status_code == 404


def test_rerender_keeps_flags_and_changes_title(env, monkeypatch, tmp_path):
    import json
    from src import clip as cliplib, config as cfgmod
    data, db = env
    src = tmp_path / "seg.mp4"
    import subprocess
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:d=3", "-f", "lavfi",
                    "-i", "sine=d=3", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", str(src)], check=True)
    monkeypatch.setattr(cliplib.download, "download_section", lambda *a, **k: src)
    db.set_flag("abcdefghijk_100", "favorite", 1)
    cfg = cfgmod.load_config()
    cfg["render"]["preset"] = "ultrafast"
    new = cliplib.rerender(db, data, "abcdefghijk_100", cfg, "Nouveau titre")
    row = db.get_clip("abcdefghijk_100")
    assert row["hook"] == "Nouveau titre" and row["favorite"] == 1 and row["seen"] == 1
    assert (data / "clips" / "abcdefghijk_100.mp4").stat().st_size == new["file_size"]
