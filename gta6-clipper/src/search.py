"""Recherche des vidéos : YouTube Data API v3 si clé, sinon yt-dlp (recherche filtrée par date)."""
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from yt_dlp import YoutubeDL

from . import download

log = logging.getLogger(__name__)
API = "https://www.googleapis.com/youtube/v3/"


class QuotaExceeded(Exception):
    pass


def iso_duration(s: str) -> int:
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    if not m:
        return 0
    d, h, mi, se = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + se


def _api_get(endpoint, params, key):
    url = API + endpoint + "?" + urllib.parse.urlencode({**params, "key": key})
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="ignore")
        if e.code == 403 and ("quotaExceeded" in body or "dailyLimitExceeded" in body):
            raise QuotaExceeded("quota YouTube API dépassé") from e
        raise


def api_candidates(scfg, key, db, known):
    after = (datetime.now(timezone.utc) - timedelta(days=scfg["days"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    ids = []
    for q in scfg["queries"]:
        ck = f"search:api:{q}:{scfg['days']}:{scfg['results_per_query']}"
        found = db.cache_get(ck, scfg["cache_hours"] * 3600)
        if found is None:
            res = _api_get("search", {"part": "id", "type": "video", "q": q, "order": "viewCount",
                                      "publishedAfter": after, "relevanceLanguage": "fr",
                                      "maxResults": min(50, scfg["results_per_query"])}, key)
            found = [it["id"]["videoId"] for it in res.get("items", [])]
            db.cache_set(ck, found)
        ids += [i for i in found if i not in ids and i not in known]
    out = []
    for i in range(0, len(ids), 50):
        res = _api_get("videos", {"part": "snippet,contentDetails,statistics", "id": ",".join(ids[i:i + 50])}, key)
        for it in res.get("items", []):
            sn, st = it["snippet"], it.get("statistics", {})
            out.append({
                "id": it["id"], "title": sn["title"], "channel": sn["channelTitle"], "url": download.watch_url(it["id"]),
                "published_at": sn["publishedAt"].replace("Z", "+00:00"),
                "duration": iso_duration(it["contentDetails"]["duration"]),
                "views": int(st.get("viewCount", 0)), "likes": int(st.get("likeCount", 0)),
                "live": sn.get("liveBroadcastContent", "none") != "none",
                "language": sn.get("defaultAudioLanguage") or sn.get("defaultLanguage"),
            })
    return out


# Filtre « date de mise en ligne » de YouTube (paramètre sp) : aujourd'hui, semaine, mois, année
UPLOAD_FILTERS = [(1, "EgIIAg%3D%3D"), (7, "EgIIAw%3D%3D"), (31, "EgIIBA%3D%3D"), (365, "EgIIBQ%3D%3D")]


def search_url(q, days):
    sp = next((v for d, v in UPLOAD_FILTERS if days <= d), UPLOAD_FILTERS[-1][1])
    return f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(q)}&sp={sp}"


def ytdlp_candidates(scfg, db, known):
    flat = []
    n = scfg["results_per_query"]
    opts = {**download.BASE_OPTS, "extract_flat": "in_playlist", "skip_download": True, "playlistend": n}
    with YoutubeDL(opts) as y:
        for q in scfg["queries"]:
            ck = f"search:ytdlp:{q}:{scfg['days']}:{n}"
            entries = db.cache_get(ck, scfg["cache_hours"] * 3600)
            if entries is None:
                res = None
                for target in (search_url(q, scfg["days"]), f"ytsearch{n}:{q}"):  # filtre de date, sinon recherche simple
                    try:
                        res = y.extract_info(target, download=False)
                        break
                    except Exception as e:
                        log.warning("Recherche yt-dlp échouée pour %r : %s", q, str(e).splitlines()[0])
                if res is None:
                    continue
                entries = [{"id": e.get("id"), "duration": e.get("duration"), "views": e.get("view_count"),
                            "channel": e.get("channel") or e.get("uploader"), "url": e.get("url") or ""}
                           for e in res.get("entries", []) if e and e.get("id")]
                db.cache_set(ck, entries)
            flat += entries
    lo, hi = scfg["min_duration_min"] * 60, scfg["max_duration_min"] * 60
    black = {c.lower() for c in scfg["channel_blacklist"]}
    white = {c.lower() for c in scfg["channel_whitelist"]}
    seen, pre = set(), []
    for e in flat:
        ch = (e.get("channel") or "").lower()
        if e["id"] in seen or e["id"] in known or ch in black or "/shorts/" in e["url"]:
            continue
        seen.add(e["id"])
        if e.get("duration") and not lo <= e["duration"] <= hi:
            continue
        if e.get("views") is not None and e["views"] < scfg["min_views"] and ch not in white:
            continue
        pre.append(e)
    pre.sort(key=lambda e: -(e.get("views") or 0))
    out = []
    for e in pre[: scfg["max_candidates"]]:  # extraction détaillée (date, likes, heatmap) mise en cache
        try:
            out.append(download.info_to_candidate(download.fetch_info(e["id"], db)))
        except Exception as ex:
            log.warning("Vidéo %s ignorée : %s", e["id"], str(ex).splitlines()[0])
    return out


def filter_and_rank(cands, scfg, now=None, known=()):
    """Filtres (langue, âge, durée, vues, live, listes) puis score = vues/heure + ratio likes/vues (normalisés)."""
    now = now or datetime.now(timezone.utc)
    black = {c.lower() for c in scfg["channel_blacklist"]}
    white = {c.lower() for c in scfg["channel_whitelist"]}
    lo, hi = scfg["min_duration_min"] * 60, scfg["max_duration_min"] * 60
    kept = []
    for c in cands:
        ch = (c.get("channel") or "").lower()
        if c["id"] in known or ch in black or c.get("live") or not lo <= (c.get("duration") or 0) <= hi:
            continue
        lang = (c.get("language") or "").lower()
        if lang and not lang.startswith("fr"):
            continue
        if not c.get("published_at"):
            continue
        age_h = max(1.0, (now - datetime.fromisoformat(c["published_at"])).total_seconds() / 3600)
        if age_h > scfg["days"] * 24:
            continue
        wl = ch in white
        if (c.get("views") or 0) < scfg["min_views"] and not wl:
            continue
        kept.append({**c, "vph": c["views"] / age_h, "like_ratio": (c.get("likes") or 0) / max(1, c["views"]),
                     "whitelisted": wl})

    def norm(vals):
        lo_, hi_ = min(vals), max(vals)
        return [1.0 if hi_ == lo_ else (v - lo_) / (hi_ - lo_) for v in vals]

    if kept:
        for c, nv, nr in zip(kept, norm([c["vph"] for c in kept]), norm([c["like_ratio"] for c in kept])):
            c["score"] = round(0.7 * nv + 0.3 * nr + (1.0 if c["whitelisted"] else 0.0), 4)
    kept.sort(key=lambda c: -c["score"])
    return kept[: scfg["top_n"]]


def search_videos(scfg, db):
    known = db.known_ids(scfg.get("max_attempts", 3))
    key = os.environ.get("YOUTUBE_API_KEY")
    cands = None
    if key:
        try:
            cands = api_candidates(scfg, key, db, known)
            log.info("API YouTube : %d candidats", len(cands))
        except QuotaExceeded as e:
            log.warning("%s : bascule sur yt-dlp", e)
        except Exception as e:
            log.warning("API YouTube en erreur (%s) : bascule sur yt-dlp", e)
    if cands is None:
        cands = ytdlp_candidates(scfg, db, known)
        log.info("yt-dlp : %d candidats détaillés", len(cands))
    return filter_and_rank(cands, scfg, known=known)
