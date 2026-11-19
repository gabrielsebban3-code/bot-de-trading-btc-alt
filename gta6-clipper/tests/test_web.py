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
