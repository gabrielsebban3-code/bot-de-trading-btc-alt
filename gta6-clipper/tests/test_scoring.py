from datetime import datetime, timedelta, timezone

import numpy as np

from src import scoring, search, vertical
from src.config import DEFAULTS

M = {**DEFAULTS["moments"], "min_clip_s": 20, "max_clip_s": 45, "target_clip_s": 32}  # données factices courtes


def fake_segments(duration, every=6.0):
    t, segs, i = 0.0, [], 0
    while t + every <= duration:
        segs.append({"start": t, "end": t + every - 0.4, "text": f"phrase numéro {i} sur le jeu"})
        t += every
        i += 1
    return segs


def test_heatmap_signal_normalized_and_absent():
    hm = [{"start_time": 0, "end_time": 10, "value": 0.2}, {"start_time": 10, "end_time": 20, "value": 1.0}]
    sig = scoring.heatmap_signal(hm, 20)
    assert sig[5] == 0 and sig[15] == 1
    assert scoring.heatmap_signal(None, 20) is None


def test_combine_ignores_missing_signals():
    a = np.ones(10)
    out = scoring.combine({"heatmap": None, "audio": a}, {"heatmap": 0.5, "audio": 0.25}, 10)
    assert np.allclose(out, 1.0)


def test_pick_windows_respects_gap():
    ws = np.zeros(400)
    ws[100], ws[110], ws[300] = 1.0, 0.9, 0.8
    picks = scoring.pick_windows(ws, 3, 30, 60)
    starts = [p[0] for p in picks]
    assert starts[0] == 100 and 110 not in starts and 300 in starts
    for i, a in enumerate(picks):
        for b in picks[i + 1:]:
            assert a[0] >= b[1] + 60 or b[0] >= a[1] + 60


def test_snap_to_sentence_boundaries_and_length():
    segs = fake_segments(300)
    s, e, aligned = scoring.snap_to_sentences(101, 133, segs, 20, 45, 0.5, 300)
    assert aligned
    assert any(abs(seg["start"] - (s + 0.5)) < 1e-6 for seg in segs)
    assert any(abs(seg["end"] - (e - 0.5)) < 1e-6 for seg in segs)
    assert 20 <= e - s <= 45


def test_snap_fallback_without_segments():
    s, e, aligned = scoring.snap_to_sentences(50, 82, [], 20, 45, 0.5, 300)
    assert not aligned and 20 <= e - s <= 45


def test_select_moments_finds_heatmap_peak():
    dur = 600
    segs = fake_segments(dur)
    hm = [{"start_time": t, "end_time": t + 10, "value": 1.0 if 400 <= t < 440 else 0.1} for t in range(0, dur, 10)]
    rms = np.full(dur, -30.0)
    moments = scoring.select_moments(dur, segs, hm, rms, M)
    assert 1 <= len(moments) <= M["clips_per_video"]
    best = moments[0]
    assert best["start"] < 440 and best["end"] > 400
    for m in moments:
        assert M["min_clip_s"] <= m["end"] - m["start"] <= M["max_clip_s"]
    ordered = sorted(moments, key=lambda m: m["start"])
    for a, b in zip(ordered, ordered[1:]):
        assert b["start"] - a["end"] >= M["min_gap_s"]


def test_select_moments_audio_only_when_no_heatmap_no_transcript():
    dur = 300
    rms = np.full(dur, -40.0)
    rms[200:230] = -5.0
    moments = scoring.select_moments(dur, [], None, rms, M)
    assert moments and moments[0]["start"] <= 205 and moments[0]["end"] >= 220


def test_keyword_signal_peaks_on_keywords():
    segs = [{"start": 0, "end": 5, "text": "bonjour à tous"}, {"start": 50, "end": 55, "text": "c'est incroyable, regardez la map !"}]
    sig = scoring.keyword_signal(segs, 100, M["keywords"])
    assert sig[52] > sig[2]


def test_filter_and_rank():
    now = datetime(2026, 11, 19, tzinfo=timezone.utc)
    base = {"duration": 600, "likes": 100, "live": False, "language": "fr"}
    def c(i, **kw):
        return {**base, "id": i, "channel": f"ch{i}", "views": 10000,
                "published_at": (now - timedelta(hours=10)).isoformat(), **kw}
    cands = [c("a", views=50000), c("b"), c("old", published_at=(now - timedelta(days=9)).isoformat()),
             c("short", duration=50), c("live", live=True), c("en", language="en"), c("few", views=100),
             c("bl", channel="Spam"), c("known")]
    scfg = {**DEFAULTS["search"], "channel_blacklist": ["spam"], "top_n": 5}
    out = search.filter_and_rank(cands, scfg, now=now, known={"known"})
    assert [x["id"] for x in out] == ["a", "b"]


def test_iso_duration():
    assert search.iso_duration("PT1H2M3S") == 3723 and search.iso_duration("PT45S") == 45


def test_subtitle_events_relative_and_bounded():
    segs = [{"start": 10, "end": 16, "text": "un deux trois quatre cinq six sept huit neuf dix"}]
    ev = vertical.subtitle_events(segs, 12, 40)
    assert ev and all(0 <= s < e <= 28 for s, e, _ in ev)
    ass = vertical.build_ass(ev, "Source : {Chaîne}", 28)
    assert "Source : (Chaîne)" in ass and "PlayResY: 1920" in ass


def test_snap_respects_gap_with_existing_clip():
    segs = fake_segments(300)
    s, e, aligned = scoring.snap_to_sentences(152, 184, segs, 20, 45, 0.5, 300, avoid=[(59.5, 90.1)], gap=60)
    assert aligned and s >= 90.1 + 60


def test_transcribe_passes_array_not_path(tmp_path, monkeypatch):
    import wave
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x10" * 16000)
    seen = {}
    class FakeModel:
        def transcribe(self, audio, **kw):
            seen["type"] = type(audio)
            return iter([SimpleNamespace(start=0.0, end=1.0, text=" salut ", words=[SimpleNamespace(start=0.1, end=0.6, word=" salut")])]), None
        def detect_language(self, audio=None, **kw):
            seen["lang_type"] = type(audio)
            return "fr", 0.99, []
    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    tcfg = DEFAULTS["transcription"]
    assert transcribe.detect_language(wav, tcfg, 1.0)[0] == "fr"
    pcts = []
    segs = transcribe.transcribe(wav, "vid", tcfg, DB(tmp_path / "db.sqlite"), on_progress=pcts.append)
    assert segs == [{"start": 0.0, "end": 1.0, "text": "salut", "words": [[0.1, 0.6, "salut"]]}]
    assert pcts and pcts[-1] <= 99
    assert seen["type"] is np.ndarray and seen["lang_type"] is np.ndarray


def test_search_url_uses_upload_filter():
    from yt_dlp.extractor import gen_extractor_classes
    url = search.search_url("GTA 6 map", 7)
    assert "search_query=GTA+6+map" in url and "sp=EgIIAw%3D%3D" in url
    assert any(ie.suitable(url) for ie in gen_extractor_classes() if ie.ie_key() == "YoutubeSearchURL")


def test_subtitles_use_word_timings():
    segs = [{"start": 10, "end": 20, "text": "a b c d e f g h",
             "words": [[10 + i, 10.8 + i, w] for i, w in enumerate("abcdefgh")]}]
    ev = vertical.subtitle_events(segs, 12, 40, max_words=3, highlight=False)
    assert ev[0] == (0.0, 2.8, "c d e") and ev[1] == (3.0, 5.8, "f g h")


def test_failed_videos_are_retried_then_dropped(tmp_path):
    from src.db import DB
    db = DB(tmp_path / "db.sqlite")
    v = {"id": "vid00000001"}
    db.upsert_video({"id": "okvideo0001"}, "ok")
    db.upsert_video(v, "error", "boom")
    assert db.known_ids(3) == {"okvideo0001"}
    db.upsert_video(v, "error", "boom")
    db.upsert_video(v, "error", "boom")
    assert "vid00000001" in db.known_ids(3)


def test_legacy_db_gets_attempts_column(tmp_path):
    import sqlite3
    from src.db import DB
    path = tmp_path / "old.sqlite"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT, channel TEXT, url TEXT, published_at TEXT, "
              "duration REAL, views INTEGER, likes INTEGER, score REAL, status TEXT, error TEXT, processed_at REAL)")
    c.execute("INSERT INTO videos (id, status) VALUES ('legacy00001', 'error')")
    c.commit(); c.close()
    db = DB(path)
    assert "legacy00001" not in db.known_ids()
    db.upsert_video({"id": "legacy00001"}, "ok")
    assert "legacy00001" in db.known_ids()


def test_cli_run_refuses_when_job_running(tmp_path, monkeypatch):
    import json, time
    from src import jobs
    monkeypatch.setattr(jobs, "data_dir", lambda: tmp_path)
    (tmp_path / "job.json").write_text(json.dumps({"running": True, "updated_at": time.time()}))
    res = jobs.run_pipeline(DEFAULTS, db=object())
    assert "tourne déjà" in res["fatal"]


def test_subtitles_break_on_punctuation_and_highlight_contiguous():
    ws = [[0.0, 0.4, "Regardez"], [0.5, 0.8, "ça,"], [0.9, 1.2, "c'est"], [1.3, 1.8, "énorme"], [1.9, 2.0, "!"]]
    segs = [{"start": 0, "end": 2.0, "text": " ".join(w[2] for w in ws), "words": ws}]
    plain = vertical.subtitle_events(segs, 0, 10, highlight=False)
    assert [e[2] for e in plain] == ["Regardez ça,", "c'est énorme !"]
    hl = vertical.subtitle_events(segs, 0, 10, highlight=True, upper=True)
    assert len(hl) == 5 and vertical.HIGHLIGHT + "REGARDEZ" in hl[0][2]
    assert hl[0][1] == hl[1][0]  # contigus dans un même bloc : jamais deux lignes à l'écran
    assert "{" not in vertical.subtitle_events([{"start": 0, "end": 1, "text": "a {b}", "words": [[0, 0.9, "{b}"]]}], 0, 1, highlight=False)[0][2]


def test_fast_mode_regions_cover_selected_moments():
    dur = 900
    segs = fake_segments(dur)
    hm = [{"start_time": t, "end_time": t + 10, "value": 1.0 if t in (300, 310, 600) else 0.1} for t in range(0, dur, 10)]
    rms = np.full(dur, -30.0)
    m0 = {**M, "weights": {**M["weights"], "keywords": 0}}
    wins = scoring.candidate_windows(dur, hm, rms, m0, M["clips_per_video"] * 2)
    regions = scoring.merge_regions(wins, dur)
    assert sum(e - s for s, e in regions) < dur / 2
    partial = [s for s in segs if any(rs <= s["start"] and s["end"] <= re for rs, re in regions)]
    moments = scoring.select_moments(dur, partial, hm, rms, m0)
    assert moments and all(m["aligned"] for m in moments)
    assert all(any(rs <= m["start"] and m["end"] <= re for rs, re in regions) for m in moments)


def test_merge_regions():
    assert scoring.merge_regions([(100, 132), (140, 172), (500, 532)], 520, pad=20) == [(80.0, 192.0), (480.0, 520.0)]


def test_transcribe_regions_offsets_timestamps(tmp_path, monkeypatch):
    import wave
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x00" * 16000 * 100)
    calls = []
    class FakeModel:
        def transcribe(self, audio, **kw):
            calls.append((len(audio), kw["beam_size"]))
            return iter([SimpleNamespace(start=1.0, end=2.0, text=" mot", words=[SimpleNamespace(start=1.0, end=1.5, word=" mot")])]), None
    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    tcfg = {**DEFAULTS["transcription"], "mode": "tres_rapide"}
    segs = transcribe.transcribe(wav, "v", tcfg, DB(tmp_path / "db.sqlite"), regions=[(10.0, 30.0), (60.0, 70.0)])
    assert calls == [(320000, 1), (160000, 1)]
    assert [s["start"] for s in segs] == [11.0, 61.0] and segs[1]["words"][0][:2] == [61.0, 61.5]


def test_silent_loud_passage_loses_to_speech():
    dur = 600
    rms = np.full(dur, -35.0)
    rms[100:140] = -3.0  # explosions sans commentaire
    rms[400:440] = -12.0  # quelqu'un parle avec enthousiasme
    spans = [[390, 450]]
    speech = scoring.speech_signal(spans, dur)
    without = scoring.select_moments(dur, [], None, rms, M)
    with_speech = scoring.select_moments(dur, [], None, rms, M, speech)
    assert without[0]["start"] < 140
    assert 380 <= with_speech[0]["start"] <= 420 and with_speech[0]["signals"]["parole"] > 0.5


def test_speech_adjust_no_speech_detected_leaves_scores():
    ws = np.array([0.2, 0.8])
    assert np.allclose(scoring.speech_adjust(ws, np.zeros(40), 30, 0.5), ws)


def lets_play(seed=0):
    """59 min de let's play : jeu bruyant constant, parole quasi continue, heatmap haute à l'intro."""
    rng = np.random.default_rng(seed)
    dur = 3548
    rms = -15 + rng.normal(0, 1.5, dur)          # bruit du jeu, fort en permanence
    rms[1500:1506] += 12                          # cri / fou rire de 6 s
    hm = []
    for i in range(100):
        s = i * dur / 100
        v = 0.35 + 0.05 * rng.random()
        if i == 0:
            v = 1.0                                # tout le monde démarre la vidéo
        if i == 70:
            v = 0.95                               # le vrai moment culte (~41:24)
        hm.append({"start_time": s, "end_time": s + dur / 100, "value": v})
    speech = scoring.speech_signal([[0, dur]], dur)
    return dur, rms, hm, speech


def test_lets_play_skips_intro_and_finds_real_peaks():
    dur, rms, hm, speech = lets_play()
    moments = scoring.select_moments(dur, [], hm, rms, M, speech)
    starts = [m["start"] for m in moments]
    assert all(s >= 60 for s in starts)                                 # pas l'intro
    peak = 70 * dur / 100
    assert any(m["start"] <= peak + 20 and m["end"] >= peak + 5 for m in moments)  # pic heatmap
    assert any(m["start"] <= 1503 <= m["end"] for m in moments)        # le cri


def test_peak_lands_in_second_part_of_clip():
    sig = np.zeros(400)
    sig[200:205] = 1.0
    ws = scoring.peak_window_scores(sig, 32)
    t = int(np.argmax(ws))
    assert 0.5 <= (202 - t) / 32 <= 1.0


def test_voice_excitement_ignores_constant_loud_game():
    rms = np.full(600, -10.0)      # jeu très fort tout le temps
    rms[300:305] = 2.0             # la voix monte d'un coup
    ex = scoring.voice_excitement(rms)
    assert ex[302] == 1.0 and ex[100] == 0.0


def test_comment_timestamps_parsed_and_weighted():
    from src.download import parse_stamps
    comments = [{"text": "23:45 mdr la police", "like_count": 200}, {"text": "le 1:02:03 !!", "like_count": 0},
                {"text": "à 99:99 rien", "like_count": 5}, {"text": "pas d'heure ici", "like_count": 9}]
    stamps = parse_stamps(comments, 4000)
    assert sorted(t for t, _ in stamps) == [1425, 3723]
    assert dict(stamps)[1425] > dict(stamps)[3723]
    sig = scoring.comments_signal(stamps, 4000)
    assert int(np.argmax(sig)) == 1425


def test_fast_mode_keywords_break_ties_between_candidates():
    dur = 1200
    rms = np.full(dur, -20.0)
    hm = [{"start_time": t, "end_time": t + 12, "value": 1.0 if t in (300, 312, 900, 912) else 0.3} for t in range(0, dur, 12)]
    m = {**M, "clips_per_video": 1}
    wins = scoring.candidate_windows(dur, hm, rms, m, 3)
    regions = scoring.merge_regions(wins, dur)
    segs = [{"start": t, "end": t + 5.6, "text": "bon on continue la route"} for t in range(0, dur, 6)]
    for s in segs:
        if 900 <= s["start"] < 930:
            s["text"] = "oh non c'est fou, j'y crois pas, mdr !"
    best = scoring.select_moments(dur, segs, hm, rms, m, regions=regions)[0]
    assert 880 <= best["start"] <= 935


def test_transcribe_can_be_cancelled_mid_way(tmp_path, monkeypatch):
    import wave
    import pytest
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x00" * 16000 * 10)

    class FakeModel:
        def transcribe(self, audio, **kw):
            return (SimpleNamespace(start=i, end=i + 1, text=" x", words=[]) for i in range(10)), None

    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    calls = []

    def check():
        calls.append(1)
        if len(calls) == 3:
            raise RuntimeError("annulé")

    with pytest.raises(RuntimeError):
        transcribe.transcribe(wav, "v", DEFAULTS["transcription"], DB(tmp_path / "db.sqlite"), cancel_check=check)
    assert len(calls) == 3


def test_hook_title_quote_fallback_and_emoji():
    from src.clip import hook_title, clean_text
    video = {"title": "JE JOUE A GTA 6 POUR LA PREMIERE FOIS 😱🔥", "channel": "LaSalle"}
    segs = [{"start": 0, "end": 5, "text": "bon on va rouler un peu. C'est pas GTA, ça ?! Regarde les routes."}]
    assert hook_title(segs, 0, 10, video, "auto", M) == "LaSalle : « C'est pas GTA, ça ?! »"
    flat = [{"start": 0, "end": 5, "text": "on roule tranquillement vers la plage en voiture"}]
    assert hook_title(flat, 0, 10, video, "auto", M) == "JE JOUE A GTA 6 POUR LA PREMIERE FOIS"
    assert hook_title(segs, 0, 10, video, "none", M) == ""
    assert clean_text("déçu ! 😱😱 ok") == "déçu ! ok"


def test_build_ass_title_styles_and_layouts():
    for layout in ("zoom", "noir", "flou"):
        for style in ("encadre", "texte"):
            ass = vertical.build_ass([], "Source : X", 30, title="Titre {test}", layout=layout, title_style=style)
            assert "Style: Title," in ass and "Titre (test)" in ass
    assert "Title,Titre" not in vertical.build_ass([], "Source : X", 30, title="")


def test_default_clips_last_at_least_one_minute():
    dur = 1800
    segs = fake_segments(dur)
    hm = [{"start_time": t, "end_time": t + 18, "value": 1.0 if t in (540, 1260) else 0.3} for t in range(0, dur, 18)]
    moments = scoring.select_moments(dur, segs, hm, np.full(dur, -30.0), DEFAULTS["moments"])
    assert moments and all(60 <= m["end"] - m["start"] <= 90 for m in moments)
    assert all(m["aligned"] for m in moments)


def test_old_config_upgraded_once_to_one_minute(tmp_path, monkeypatch):
    import yaml
    from src import config
    monkeypatch.setattr(config, "ROOT", tmp_path)
    (tmp_path / "config.yaml").write_text("moments:\n  min_clip_s: 20\n  max_clip_s: 45\n  target_clip_s: 32\n  clips_per_video: 2\n")
    cfg = config.load_config()
    assert (cfg["moments"]["min_clip_s"], cfg["moments"]["max_clip_s"]) == (60, 90)
    assert cfg["moments"]["clips_per_video"] == 2            # les autres réglages sont gardés
    saved = yaml.safe_load((tmp_path / "config.yaml").read_text(encoding="utf-8"))
    assert saved["version"] == 2
    saved["moments"]["min_clip_s"] = 35                        # un choix fait ensuite dans Réglages est respecté
    (tmp_path / "config.yaml").write_text(yaml.safe_dump(saved))
    assert config.load_config()["moments"]["min_clip_s"] == 35


def test_parse_time_and_url_time():
    from src.download import parse_time, url_time
    assert parse_time("41:20") == 2480 and parse_time("1:02:03") == 3723 and parse_time("2480") == 2480
    assert parse_time("41m20s") == 2480 and parse_time("2480s") == 2480 and parse_time("bof") is None
    assert url_time("https://youtu.be/Yf1o5Ccu6Lg?t=2480") == 2480
    assert url_time("https://www.youtube.com/watch?v=Yf1o5Ccu6Lg&t=41m20s") == 2480
    assert url_time("https://youtu.be/Yf1o5Ccu6Lg?si=abc") is None


def test_manual_window_puts_moment_at_60_percent():
    m = {**DEFAULTS["moments"]}
    t0, t1 = scoring.manual_window(2480, 3548, m)
    assert t1 - t0 == m["target_clip_s"] and abs((2480 - t0) / (t1 - t0) - 0.6) < 0.01
    assert scoring.manual_window(10, 3548, m)[0] == 0           # début de vidéo
    assert scoring.manual_window(3540, 3548, m)[1] == 3548      # fin de vidéo


def test_learn_weights_follows_ratings():
    base = {"heatmap": 0.5, "audio": 0.25, "keywords": 0.25, "comments": 0.4}
    good = [(1, {"heatmap": 0.9, "audio": 0.1}) for _ in range(3)]
    bad = [(-1, {"heatmap": 0.2, "audio": 0.8}) for _ in range(3)]
    w, learned = scoring.learn_weights(good + bad, base)
    assert learned and w["heatmap"] > base["heatmap"] and w["audio"] < base["audio"]
    assert w["keywords"] == base["keywords"]                    # pas d'info : inchangé
    assert scoring.learn_weights(good + bad[:2], base) == (base, False)  # pas assez de notes


def test_ytdlp_age():
    import datetime as dt
    from src.main import ytdlp_age_days
    assert ytdlp_age_days("2026.10.26", dt.date(2026, 11, 19)) == 24
    assert ytdlp_age_days("inconnue") is None


def test_windows_scripts_are_crlf_ascii():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    for name in ("maj.bat", "planifier.bat", "lancer_run.bat"):
        raw = (root / name).read_bytes()
        raw.decode("ascii")
        assert raw.count(b"\n") == raw.count(b"\r\n") > 3


def test_youtube_only_links():
    import pytest
    from src.download import video_id, moment_url, url_time
    assert video_id("https://youtu.be/Yf1o5Ccu6Lg?t=2480") == "Yf1o5Ccu6Lg" and url_time("https://youtu.be/Yf1o5Ccu6Lg?t=2480") == 2480
    assert moment_url("Yf1o5Ccu6Lg", 2480.7) == "https://youtu.be/Yf1o5Ccu6Lg?t=2480"
    with pytest.raises(ValueError):
        video_id("https://www.twitch.tv/videos/2933600681")


def test_live_chat_parsed_and_burst_detected():
    import json
    from src.download import parse_live_chat

    def line(ms, text):
        item = {"replayChatItemAction": {"actions": [{"addChatItemAction": {"item": {"liveChatTextMessageRenderer": {
            "message": {"runs": [{"text": text}]}}}}}], "videoOffsetTimeMsec": str(ms)}}
        return json.dumps(item, ensure_ascii=False)

    lines = [line(t * 1000, "on avance") for t in range(0, 1200, 4)]          # rythme normal
    lines += [line(600_000 + i * 100, "MDRRR 😂") for i in range(60)]          # explosion à 10:00
    lines.append('{"other": "sans horodatage"}')
    msgs, fun = parse_live_chat(lines, 1200)
    assert sum(msgs) == 300 + 60 and fun[603] > 0 and fun[100] == 0
    sig = scoring.chat_signal({"messages": msgs, "reactions": fun}, 1200)
    assert 590 <= int(np.argmax(sig)) <= 606                                    # avancé : réaction après le moment
    dur = 1200
    m = scoring.select_moments(dur, [], None, np.full(dur, -30.0), {**M, "clips_per_video": 1},
                               chat={"messages": msgs, "reactions": fun})[0]
    assert m["start"] <= 596 <= m["end"] and m["signals"]["chat"] > 0.1   # explosion de 6 s dans un clip de 33 s


def test_transcribe_offset_shifts_timestamps(tmp_path, monkeypatch):
    import wave
    from types import SimpleNamespace
    from src import transcribe
    from src.db import DB
    wav = tmp_path / "a.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b"\x00\x00" * 16000 * 5)

    class FakeModel:
        def transcribe(self, audio, **kw):
            return iter([SimpleNamespace(start=1.0, end=2.0, text=" mdr", words=[SimpleNamespace(start=1.0, end=1.4, word=" mdr")])]), None

    monkeypatch.setattr(transcribe, "get_model", lambda tcfg: FakeModel())
    segs = transcribe.transcribe(wav, "abcdefghijk", DEFAULTS["transcription"], DB(tmp_path / "db.sqlite"), offset=2432.0)
    assert segs[0]["start"] == 2433.0 and segs[0]["words"][0][:2] == [2433.0, 2433.4]


def test_jump_cuts_silences_fillers_and_minimum():
    from src.clip import jump_cuts, cut_timeline
    words = [[100.0, 100.4, "Regardez"], [100.5, 100.9, "ça"], [102.5, 102.8, "euh"], [103.0, 103.4, "c'est"],
             [103.5, 104.0, "énorme"], [107.0, 107.5, "!"]]
    segs = [{"start": 100.0, "end": 107.5, "text": " ".join(w[2] for w in words), "words": words}]
    r = {"jump_cuts": True, "jump_cut_min_silence": 0.7}
    cuts = jump_cuts(segs, 99.0, 109.0, r, min_len=0)
    removed = sum(b - a for a, b in cuts)
    assert abs(removed - 4.0) < 0.01                            # 1,1 s + « euh » 0,4 s + 2,5 s de blancs
    assert not any(a < 100.4 < b or a < 103.6 < b for a, b in cuts)   # jamais dans un mot gardé
    shown, dur, keep = cut_timeline(segs, 99.0, 109.0, cuts)
    texts = [w[2] for s in shown for w in s["words"]]
    assert "euh" not in texts and texts[0] == "Regardez" and abs(dur - (10 - removed)) < 1e-6
    assert all(w[0] < w2[0] for w, w2 in zip(shown[0]["words"], shown[0]["words"][1:]))
    assert shown[0]["words"][-1][1] <= 99.0 + dur
    assert jump_cuts(segs, 99.0, 109.0, r, min_len=9.0) == [] or 10 - sum(b - a for a, b in jump_cuts(segs, 99.0, 109.0, r, min_len=9.0)) >= 9.0
    assert jump_cuts(segs, 99.0, 109.0, {"jump_cuts": False}, 0) == []


def test_hook_title_stays_short():
    from src.clip import hook_title
    video = {"title": "x" * 10 + " un titre de vidéo vraiment beaucoup trop long pour un clip vertical", "channel": "Une chaîne au nom très long"}
    segs = [{"start": 0, "end": 5, "text": "Vice City a l'air incroyable, regarde !"}]
    t = hook_title(segs, 0, 10, video, "auto", M)
    assert t == "« Vice City a l'air incroyable, regarde ! »"     # nom de chaîne retiré : trop long
    longue = [{"start": 0, "end": 5, "text": "Vice City a l'air incroyable dans cette version !"}]
    assert hook_title(longue, 0, 10, video, "auto", M).endswith("…")  # phrase > 42 car. : titre de la vidéo raccourci
    assert len(hook_title([], 0, 10, video, "auto", M)) <= 51


def test_pick_music_stable_and_optional(tmp_path):
    import subprocess
    from src.clip import pick_music
    (tmp_path / "music").mkdir()
    r = {"music": True, "music_volume": 0.18}
    assert pick_music(tmp_path, "abc_1", 60, r) is None                     # dossier vide : pas de musique
    for name in ("a.mp3", "b.mp3"):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anoisesrc=d=100", str(tmp_path / "music" / name)], check=True)
    (tmp_path / "music" / "notes.txt").write_text("pas une musique")
    m1, m2 = pick_music(tmp_path, "abc_1", 60, r), pick_music(tmp_path, "abc_1", 60, r)
    assert m1 == m2 and m1["path"].endswith(".mp3") and 0 <= m1["offset"] <= 35 and m1["volume"] == 0.18
    assert pick_music(tmp_path, "abc_1", 60, {**r, "music": False}) is None


def test_clip_does_not_start_mid_reasoning():
    texts = ["On arrive à l'aéroport.", "Je prends l'avion le plus rapide.", "Mais du coup la police me suit.",
             "Et là c'est le drame !"] + ["On continue la route."] * 20
    segs = [{"start": i * 6.0, "end": i * 6.0 + 5.6, "text": t} for i, t in enumerate(texts)]
    s, e, aligned = scoring.snap_to_sentences(12.0, 44.0, segs, 20, 45, 0.5, 300)
    assert aligned and abs(s - (6.0 - 0.5)) < 1e-6            # reprend « Je prends l'avion… » avant « Mais du coup… »
    s2, _, _ = scoring.snap_to_sentences(30.0, 62.0, segs, 20, 45, 0.5, 300)
    assert abs(s2 - (30.0 - 0.5)) < 1e-6                       # phrase autonome : début inchangé


def test_gta_keyword_on_screen():
    from src.clip import with_keyword
    assert with_keyword("LaSalle : « Regarde les routes ! »") == "GTA 6 · LaSalle : « Regarde les routes ! »"
    assert with_keyword("Le meilleur moment de GTA VI") == "Le meilleur moment de GTA VI"   # déjà présent
    assert with_keyword("") == ""
    long_t = "x" * 56
    assert with_keyword(long_t) == long_t                                                   # trop long : inchangé
