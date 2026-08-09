#!/usr/bin/env python3
"""InterDesk corpus poller.

Fetches every enabled feed in data/feeds.json, parses RSS/Atom/RDF, tags items
with topics (data/topics.json) and counterparts (data/counterparts.json), and
bakes data/auto/corpus.json — a rolling 72-hour window the static site serves
and the client merges into IndexedDB.

Stdlib only, on purpose: the same script must run unmodified on a Mac with no
package manager and inside GitHub Actions. Do not add dependencies.

Run:  python3 tools/poller.py                # full run
      python3 tools/poller.py --source rnz-pol   # one feed, for debugging
      python3 tools/poller.py --no-net-prime     # skip the live-site prime

Env:  SITE_BASE   e.g. https://user.github.io/interdesk (prime source in CI)

Id parity is load-bearing: hash_id() must byte-match parse.js hashId() (FNV-1a
over UTF-16 code units, "i" + base36). tools/test-vectors.json is asserted at
startup; if it fails, fix the port before shipping a corpus.
"""
from __future__ import annotations

import argparse
import base64
import concurrent.futures
import email.utils
import gzip
import html
import html.parser
import io
import json
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# macOS framework Pythons ship without a CA store wired into ssl; certifi
# (if present) supplies one. CI's Ubuntu Python verifies fine either way.
# Never disable verification.
try:
    import certifi
    _SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL_CTX = ssl.create_default_context()
_OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=_SSL_CTX))
urllib.request.install_opener(_OPENER)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AUTO = DATA / "auto"
ARCHIVE = AUTO / "archive"
OUT_PATH = AUTO / "corpus.json"
PREV_PATH = AUTO / "prev-corpus.json"   # workflow-fetched, never committed
CACHE_PATH = AUTO / "http-cache.json"   # etags + resolved gnews tokens
VECTORS_PATH = Path(__file__).resolve().parent / "test-vectors.json"

WINDOW_HOURS = 72
PER_FEED_CAP = 60
SUMMARY_CHARS = 600
FETCH_TIMEOUT = 20
MAX_REDIRECT_RESOLVES = 40   # gnews resolutions per run (2 requests each); the backlog drains across runs
PARLIAMENT_GAP_S = 3         # www3.parliament.nz Radware blocks bursts

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 interdesk-poller/1.0")

NZT = timezone(timedelta(hours=12))  # NZST; ordering-grade, matches parse.js


# ---------------------------------------------------------------- id parity --

def hash_id(s: str, prefix: str = "i") -> str:
    """FNV-1a over UTF-16 code units — byte-identical to parse.js hashId()."""
    h = 0x811C9DC5
    b = s.encode("utf-16-le")
    for i in range(0, len(b), 2):
        h ^= b[i] | (b[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return prefix + to_base36(h)


def to_base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = []
    while n:
        n, r = divmod(n, 36)
        out.append(digits[r])
    return "".join(reversed(out))


def assert_vectors() -> None:
    if not VECTORS_PATH.exists():
        return
    vectors = json.loads(VECTORS_PATH.read_text())
    for v in vectors:
        got = hash_id(v["input"])
        if got != v["id"]:
            sys.exit(f"FATAL: hash_id parity broken: {v['input']!r} -> {got}, expected {v['id']}. "
                     "Fix tools/poller.py hash_id before shipping a corpus.")


# ------------------------------------------------------------------- fetch --

_cache_lock = threading.Lock()


def load_json(path: Path, fallback):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return fallback


def atomic_write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    tmp.replace(path)


def http_get(url: str, cache: dict, use_conditional: bool = True):
    """Return (status, text, from_cache). 304 -> (304, "", True)."""
    req = urllib.request.Request(url)
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*")
    req.add_header("Accept-Encoding", "gzip")
    entry = cache.get(url) or {}
    if use_conditional:
        if entry.get("etag"):
            req.add_header("If-None-Match", entry["etag"])
        if entry.get("lastmod"):
            req.add_header("If-Modified-Since", entry["lastmod"])
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as res:
            raw = res.read(5 * 1024 * 1024)  # cap: no feed is legitimately >5MB
            if res.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
                raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
            with _cache_lock:
                cache[url] = {
                    "etag": res.headers.get("ETag") or "",
                    "lastmod": res.headers.get("Last-Modified") or "",
                }
            return res.status, raw.decode("utf-8", errors="replace"), False
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, "", True
        # Keep the body head: challenge pages identify themselves there.
        try:
            body = e.read()[:200].decode("utf-8", errors="replace")
        except Exception:
            body = ""
        raise RuntimeError(f"HTTP {e.code} {body[:120]!r}") from e


def looks_like_feed(text: str) -> bool:
    head = text.lstrip()[:200].lower()
    return head.startswith(("<?xml", "<rss", "<feed", "<rdf", "{"))


# ------------------------------------------------------------------- parse --

class _TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def strip_html(raw: str) -> str:
    if not raw:
        return ""
    p = _TextExtractor()
    try:
        p.feed(html.unescape(raw))
    except Exception:
        return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", raw)).strip()
    return re.sub(r"\s+", " ", " ".join(p.parts)).strip()


AMP_RE = re.compile(r"&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)")
DATE_FALLBACK_RE = re.compile(
    r"(\d{1,2})(?:st|nd|rd|th)?\s+(\w{3})\w*\s+(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?", re.I)
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def parse_date_ms(s: str) -> int:
    if not s:
        return 0
    s = s.strip()
    try:
        dt = email.utils.parsedate_to_datetime(s)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
    except (TypeError, ValueError):
        pass
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        pass
    m = DATE_FALLBACK_RE.search(s)
    if m:
        mo = MONTHS.get(m.group(2).lower())
        if mo is not None:
            year = int(m.group(3))
            if year < 100:
                year += 2000
            hour = int(m.group(4)) % 12
            if (m.group(6) or "").lower() == "pm":
                hour += 12
            # interest.co.nz style, NZT assumed +12 — matches parse.js.
            dt = datetime(year, mo + 1, int(m.group(1)), hour, int(m.group(5)), tzinfo=NZT)
            return int(dt.timestamp() * 1000)
    return 0


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].lower()


def child_text(node, *names) -> str:
    wanted = {n.lower() for n in names}
    for el in node:
        if local_name(el.tag) in wanted and (el.text or "").strip():
            return el.text.strip()
    return ""


def parse_feed_xml(text: str, source: dict) -> list[dict]:
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        try:
            root = ET.fromstring(AMP_RE.sub("&amp;", text))
        except ET.ParseError as e:
            raise RuntimeError(f"XML parse error: {e}") from e

    nodes = [el for el in root.iter() if local_name(el.tag) == "item"]
    is_atom = False
    if not nodes:
        nodes = [el for el in root.iter() if local_name(el.tag) == "entry"]
        is_atom = True

    JUNK_TITLES = {"no feed access", "access denied", "error", "untitled"}

    items = []
    now_ms = int(time.time() * 1000)
    for node in nodes:
        title = strip_html(child_text(node, "title"))
        if not title or title.lower().strip() in JUNK_TITLES:
            continue  # some feeds (PINA) emit error pages as items
        if is_atom:
            link, fallback = "", ""
            for el in node:
                if local_name(el.tag) != "link":
                    continue
                href = el.get("href") or ""
                rel = el.get("rel") or "alternate"
                if rel == "alternate" and href:
                    link = href
                    break
                if href and not fallback:
                    fallback = href
            link = link or fallback
        else:
            link = child_text(node, "link") or child_text(node, "guid")
        link = (link or "").strip()
        if link and not re.match(r"^https?://", link, re.I):
            link = ""

        raw_summary = (child_text(node, "description") or child_text(node, "summary")
                       or child_text(node, "encoded") or child_text(node, "content"))
        published = parse_date_ms(
            child_text(node, "pubDate") or child_text(node, "published")
            or child_text(node, "updated") or child_text(node, "date"))

        gsource_domain = ""
        if source.get("kind") == "gnews":
            for el in node:
                if local_name(el.tag) == "source":
                    gsource_domain = domain_of(el.get("url") or "")
                    break

        items.append({
            "title": title,
            "link": link,
            "summary": strip_html(raw_summary)[:SUMMARY_CHARS],
            "published": published or now_ms,
            "gsourceDomain": gsource_domain,
        })
    # Some feeds (SPC) are not date-ordered: sort before capping.
    items.sort(key=lambda i: i["published"], reverse=True)
    return items[:PER_FEED_CAP]


# ---------------------------------------------------- google news handling --

GNEWS_TOKEN_RE = re.compile(r"/rss/articles/([^?/]+)")
URL_IN_BYTES_RE = re.compile(rb'https?://[^\x00-\x20"\\]+')


def domain_of(url: str) -> str:
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return ""
    return host.lower().removeprefix("www.")


def norm_title(title: str) -> str:
    # Google appends " - Outlet Name"; strip the last such suffix.
    t = re.sub(r"\s+-\s+[^-]{2,60}$", "", title)
    return re.sub(r"\s+", " ", t).strip().lower()


_resolve_budget = threading.Semaphore(MAX_REDIRECT_RESOLVES)


def canonicalise_gnews(link: str, title: str, gsource_domain: str, cache: dict) -> tuple[str, str]:
    """Return (canonical_link, id).

    The LINK upgrades as resolution succeeds (url= param -> CBMi decode ->
    cached/budgeted live resolver -> the Google redirect as-is), but the ID is
    always outlet+title: an article's identity must not change when its link
    later heals, or the window fills with duplicates of the same story."""
    item_id = hash_id(gsource_domain + "|" + norm_title(title)) if gsource_domain else hash_id(link)

    q = urllib.parse.parse_qs(urllib.parse.urlsplit(link).query)
    if q.get("url"):
        real = q["url"][0]
        if re.match(r"^https?://", real, re.I):
            return real, item_id

    m = GNEWS_TOKEN_RE.search(link)
    token = m.group(1) if m else ""
    if token:
        with _cache_lock:
            cached = (cache.get("gnews") or {}).get(token)
        if cached:
            return cached, item_id
        if token.startswith("CBMi"):
            try:
                pad = token + "=" * (-len(token) % 4)
                decoded = base64.urlsafe_b64decode(pad)
                um = URL_IN_BYTES_RE.search(decoded)
                if um:
                    real = um.group(0).decode("utf-8", errors="replace")
                    if "news.google.com" not in real:
                        with _cache_lock:
                            cache.setdefault("gnews", {})[token] = real
                        return real, item_id
            except (ValueError, UnicodeDecodeError):
                pass
        # Budgeted live resolution via Google's own resolver (see helper).
        if _resolve_budget.acquire(blocking=False):
            real = resolve_gnews_batch(link, gsource_domain)
            if real:
                with _cache_lock:
                    cache.setdefault("gnews", {})[token] = real
                return real, item_id

    return link, item_id


GNEWS_SG_RE = re.compile(r'data-n-a-sg="([^"]+)"')
GNEWS_TS_RE = re.compile(r'data-n-a-ts="([^"]+)"')


def _norm_host(h: str) -> str:
    return re.sub(r"^(www|m|amp|edition)\.", "", (h or "").lower())


def resolve_gnews_batch(link: str, gsource_domain: str) -> str:
    """Resolve a news.google.com/rss/articles link to the real article URL.

    The splash page stopped embedding the destination (verified 8 Aug 2026:
    the only external URLs in the HTML are fonts and logos); Google's own
    client resolves it with a signed DotsSplashUi/batchexecute call using a
    signature and timestamp printed on the splash. Replay exactly that, then
    accept the result ONLY if its host matches the outlet the feed already
    named — a wrong-outlet link is worse than the redirect."""
    try:
        req = urllib.request.Request(link, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=12, context=_SSL_CTX) as res:
            body = res.read(900_000).decode("utf-8", "replace")
        sg = GNEWS_SG_RE.search(body)
        ts = GNEWS_TS_RE.search(body)
        if not sg or not ts or "/articles/" not in link:
            return ""
        art_id = link.split("/articles/", 1)[1].split("?", 1)[0]
        payload = (
            '[[["Fbv4je","[\\"garturlreq\\",[[\\"en-NZ\\",\\"NZ\\",[\\"FINANCE_TOP_INDICES\\",\\"WEB_TEST_1_0_0\\"],'
            'null,null,1,1,\\"NZ:en\\",null,180,null,null,null,null,null,0,null,null,[1608992183,723341000]],'
            '\\"en-NZ\\",\\"NZ\\",1,[2,3,4,8],1,0,\\"655000234\\",0,0,null,0],\\"' + art_id + '\\",'
            + ts.group(1) + ',\\"' + sg.group(1) + '\\"]",null,"generic"]]]'
        )
        data = urllib.parse.urlencode({"f.req": payload}).encode()
        req2 = urllib.request.Request(
            "https://news.google.com/_/DotsSplashUi/data/batchexecute",
            data=data,
            headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"})
        with urllib.request.urlopen(req2, timeout=12, context=_SSL_CTX) as res2:
            out = res2.read(200_000).decode("utf-8", "replace").replace("\\/", "/")
        urls = [u for u in re.findall(r'https?://[^"\s\\]+', out) if "google" not in u]
        if not urls:
            return ""
        real = urls[0]
        if gsource_domain:
            got = _norm_host(urllib.parse.urlsplit(real).netloc)
            want = _norm_host(gsource_domain)
            if got != want and not got.endswith("." + want) and not want.endswith("." + got):
                return ""
        return real
    except Exception:
        return ""


# ------------------------------------------------------------ topic tagging --

MACRONS = str.maketrans("āēīōūĀĒĪŌŪ", "aeiouaeiou")
OKINA_RE = re.compile(r"[ʻ'’ˈ`]")


def normalise(text: str) -> str:
    t = text.translate(MACRONS)
    # Possessives first, in any apostrophe form: stripping the apostrophe
    # before the 's rule turns "Trump's" into "trumps", which then misses a
    # word-boundary "trump" seed. KEEP IN LOCKSTEP with fatopics.js normalise.
    t = re.sub(r"['’ʻˈ`]s\b", "", t, flags=re.IGNORECASE)
    t = OKINA_RE.sub("", t)
    t = re.sub(r"'s\b", "", t.lower())
    return re.sub(r"\s+", " ", t)


def word_hit(seed: str, text: str) -> bool:
    if " " in seed or "-" in seed:
        return seed in text
    return re.search(r"\b" + re.escape(seed) + r"\b", text) is not None


def cased_hit(seed: str, raw: str) -> bool:
    return re.search(r"\b" + re.escape(seed) + r"\b", raw) is not None


def in_scope(item: dict, nz_tokens: list[str]) -> bool:
    """The wire's foreign-news scope (taxonomy nzScope): foreign items must be
    significant to, related to, or concern New Zealand and its interests.
    Domestic, official and Pacific items always pass; global and analysis items
    need a topic tag, a tracked person, or an NZ-nexus token. KEEP IN LOCKSTEP
    with Fatopics.inScope."""
    if item.get("region") in ("nz", "official", "pacific"):
        return True
    if item.get("topicTags"):
        return True
    if item.get("counterparts") or item.get("leaders"):
        return True
    text = normalise(item.get("title", "") + " " + item.get("summary", "")[:300])
    return any(word_hit(t, text) for t in nz_tokens)


class Tagger:
    def __init__(self, taxonomy: dict):
        self.topics = taxonomy["topics"]
        self.scoring = taxonomy["scoring"]
        self.source_tags = taxonomy.get("sourceTags", {})

    def tag(self, item: dict, source_id: str) -> list[str]:
        s = self.scoring
        title_n = normalise(item["title"])
        summary_n = normalise(item["summary"][:s["summaryChars"]])
        title_raw = item["title"]
        summary_raw = item["summary"][:s["summaryChars"]]
        scores: dict[str, int] = {}

        for topic in self.topics:
            score = 0
            for seed in topic.get("seeds", []):
                if word_hit(seed, title_n):
                    score += s["title"]
                elif word_hit(seed, summary_n):
                    score += s["summary"]
            for seed in topic.get("cased", []):
                if cased_hit(seed, title_raw):
                    score += s["title"]
                elif cased_hit(seed, summary_raw):
                    score += s["summary"]
            for a, b in topic.get("compounds", []):
                both = title_n + " " + summary_n
                if word_hit(a, both) and word_hit(b, both):
                    score += s["title"]
            if score >= s["threshold"]:
                scores[topic["id"]] = score

        # require: dependent topic only stands if its base fired
        for topic in self.topics:
            req = topic.get("require")
            if req and topic["id"] in scores and req not in scores:
                del scores[topic["id"]]

        for forced in self.source_tags.get(source_id, []):
            scores.setdefault(forced, s["threshold"])

        keep = set(s.get("alwaysKeep", []))
        ranked = sorted(scores, key=lambda t: (-scores[t], t))
        capped = [t for t in ranked if t in keep] + [t for t in ranked if t not in keep][:s["maxTags"]]
        # preserve rank order, dedupe
        out = []
        for t in ranked:
            if t in capped and t not in out:
                out.append(t)
        return out


# ----------------------------------------------------------- leader tagging --

class LeaderTagger:
    """World-leaders pass: tag items with leaders[] and ONE scope —
    globe (what they're doing to the world) / country (at home) /
    self (what's happening to them). Runs over every item so direct-feed
    coverage is tagged, not just the per-leader query nets."""

    def __init__(self, registry: dict):
        self.leaders = registry.get("leaders", [])
        self.scopes = registry.get("scopes", {})

    def synth_sources(self) -> list[dict]:
        out = []
        for ld in self.leaders:
            q = urllib.parse.quote(ld["query"])
            out.append({
                "id": "gn-ld-" + ld["id"],
                "name": ld["name"] + " (query)",
                "stream": "leaders", "region": "global", "tier": 2,
                "kind": "gnews", "leaderId": ld["id"],
                "url": f"https://news.google.com/rss/search?q={q}&hl=en-NZ&gl=NZ&ceid=NZ:en",
            })
        return out

    def match(self, item: dict, source: dict) -> list[str]:
        ids = []
        text_n = normalise(item["title"] + " " + item["summary"][:300])
        src_ld = source.get("leaderId")
        if src_ld:
            ids.append(src_ld)
        for ld in self.leaders:
            if ld["id"] in ids:
                continue
            if any(word_hit(normalise(n), text_n) for n in ld.get("strongNames", [])):
                ids.append(ld["id"])
                continue
            surname = ld.get("weakSurname")
            if surname and word_hit(normalise(surname), text_n) \
                    and any(word_hit(normalise(c), text_n) for c in ld.get("weakContext", [])):
                ids.append(ld["id"])
        return ids

    def scope(self, item: dict, leader_ids: list[str]) -> str:
        """Leader-relative: a place foreign to THIS leader's home is a globe
        signal; their own institutions are country; courts/polls/health are
        self. Two tracked leaders in one item is diplomacy by definition."""
        title_n = normalise(item["title"])
        summary_n = normalise(item["summary"][:300])
        both = title_n + " " + summary_n
        scores = {}
        for key, cfg in self.scopes.items():
            s = 0
            for seed in cfg.get("seeds", []):
                if word_hit(seed, title_n):
                    s += 2
                elif word_hit(seed, summary_n):
                    s += 1
            for a, b in cfg.get("compounds", []):
                if word_hit(a, both) and word_hit(b, both):
                    s += 2
            scores[key] = s

        primary = next((l for l in self.leaders if l["id"] == (leader_ids[0] if leader_ids else "")), None)
        home = {normalise(t.strip()) for t in (primary.get("homeTokens", []) if primary else [])}
        foreign = set()
        for ld in self.leaders:
            if primary and ld["id"] == primary["id"]:
                continue
            for t in ld.get("homeTokens", []):
                foreign.add(normalise(t.strip()))
        for t in (self.scopes.get("globe", {}).get("places") or []):
            foreign.add(normalise(t))
        foreign -= home
        for place in foreign:
            if word_hit(place, title_n):
                scores["globe"] = scores.get("globe", 0) + 2
            elif word_hit(place, summary_n):
                scores["globe"] = scores.get("globe", 0) + 1
        if len(leader_ids) >= 2:
            scores["globe"] = scores.get("globe", 0) + 3

        best = max(scores.values() or [0])
        if best <= 0:
            return "country"
        for key in ("self", "globe", "country"):
            if scores.get(key, 0) == best:
                return key
        return "country"


# ------------------------------------------------------ counterpart tagging --

class CounterpartTagger:
    def __init__(self, registry: dict):
        self.counterparts = registry["counterparts"]

    def kind_for(self, item: dict, source: dict) -> str:
        link = item.get("link") or ""
        if "/speech/" in link:
            return "speech"
        if "/release/" in link:
            return "release"
        if source.get("kind") == "gnews":
            return "coverage"
        if source.get("id") == "scoop-pa":
            return "release"
        return ""

    def tag(self, item: dict, source: dict) -> list[dict]:
        tags: list[dict] = []
        seen: set[str] = set()

        def add(cid: str, rel: str):
            if cid not in seen:
                seen.add(cid)
                tags.append({"id": cid, "rel": rel})

        text_n = normalise(item["title"] + " " + item["summary"][:300])
        src_cp = source.get("counterpartId")
        src_rel = source.get("rel") or "subject"

        strong_matches = []
        for cp in self.counterparts:
            if cp.get("scope") == "portfolio-only":
                continue
            if word_hit(normalise(cp["matchName"]), text_n):
                strong_matches.append(cp)

        if src_cp and src_rel == "author":
            add(src_cp, "author")
        elif src_cp and src_rel == "author-unless-named":
            # dc:creator is useless on beehive portfolio feeds (verified):
            # if exactly one counterpart is named, attribute them instead.
            if len(strong_matches) == 1:
                add(strong_matches[0]["id"], "author")
            else:
                add(src_cp, "author")
        elif src_cp:
            add(src_cp, src_rel)

        for cp in strong_matches:
            rel = "subject"
            if source.get("id") == "scoop-pa":
                title_n = normalise(item["title"])
                if title_n.startswith(normalise(cp["matchName"])) or title_n.startswith(normalise(cp.get("party", ""))):
                    rel = "author"
            add(cp["id"], rel)

        # Weak rule: bare surname + portfolio context. Handles "Foreign
        # Minister Peters said..." without tagging every unrelated Mitchell.
        for cp in self.counterparts:
            if cp["id"] in seen:
                continue
            if not word_hit(normalise(cp["surname"]), text_n):
                continue
            if any(word_hit(normalise(ctx), text_n) for ctx in cp.get("weakContext", [])):
                add(cp["id"], "subject")

        return tags


# -------------------------------------------------------------------- main --

def fetch_one(source: dict, cache: dict, prev_by_source: dict) -> dict:
    """Returns {health, items} — one feed, isolated failure."""
    sid = source["id"]
    started = time.time()
    health = {"id": sid, "ok": False, "lastOk": (prev_by_source.get(sid) or {}).get("lastOk", 0),
              "status": 0, "conditional": False, "itemCount": 0,
              "ms": 0, "error": None}
    try:
        status, text, from_cache = http_get(source["url"], cache)
        health["status"] = status
        health["ms"] = int((time.time() - started) * 1000)
        if status == 304:
            health.update(ok=True, conditional=True, lastOk=int(time.time() * 1000))
            return {"health": health, "items": [], "carry": True}
        if not looks_like_feed(text):
            # Challenge pages (Incapsula/TownNews/Cloudflare) arrive as HTML:
            # transient by policy — carry the previous items, retry next run.
            raise RuntimeError("non-feed response (bot challenge?)")
        raw_items = parse_feed_xml(text, source)
        health.update(ok=True, itemCount=len(raw_items), lastOk=int(time.time() * 1000))
        return {"health": health, "items": raw_items, "carry": False}
    except Exception as e:  # noqa: BLE001 — keep polling the rest
        health["error"] = str(e)[:200]
        health["ms"] = int((time.time() - started) * 1000)
        return {"health": health, "items": [], "carry": True}


def finish_item(raw: dict, source: dict, tagger: Tagger, cp_tagger: CounterpartTagger,
                ld_tagger: "LeaderTagger", cache: dict, covered: set[str]):
    now_ms = int(time.time() * 1000)
    link = raw["link"]
    title = raw["title"]
    summary = raw["summary"]
    via = ""
    if source.get("kind") == "gnews":
        if raw.get("gsourceDomain") and raw["gsourceDomain"] in covered:
            return None  # domain suppression: the direct feed carries it
        link, item_id = canonicalise_gnews(link, raw["title"], raw.get("gsourceDomain", ""), cache)
        via = raw.get("gsourceDomain", "")
        # Google appends " - Outlet" to titles and echoes the title as the
        # summary; strip both so cards read cleanly.
        stripped = re.sub(r"\s+-\s+[^-]{2,60}$", "", title).strip()
        if stripped:
            title = stripped
        if normalise(summary).startswith(normalise(title)[:80]):
            summary = ""
    else:
        item_id = hash_id(link or source["id"] + "|" + raw["title"])

    item = {
        "id": item_id,
        "sourceId": source["id"],
        "sourceName": source["name"],
        "stream": source["stream"],
        "region": source.get("region", "global"),
        "tier": source.get("tier", 2),
        "title": title,
        "link": link,
        "summary": summary,
        "published": raw["published"],
        "fetchedAt": now_ms,
        "storyId": None,
        "topicTags": [],
        "counterparts": [],
    }
    if via:
        item["via"] = via
    item["topicTags"] = tagger.tag(item, source["id"])
    cps = cp_tagger.tag(item, source)
    if cps:
        item["counterparts"] = cps
        kind = cp_tagger.kind_for(item, source)
        if kind:
            item["kind"] = kind
    lds = ld_tagger.match(item, source)
    if lds:
        item["leaders"] = lds
        item["scope"] = ld_tagger.scope(item, lds)
    return item



def load_previous() -> dict:
    """Prime from (1) workflow-fetched prev-corpus.json, (2) local corpus.json,
    (3) SITE_BASE live fetch. Missing everywhere -> fresh start, self-heals."""
    import os
    for path in (PREV_PATH, OUT_PATH):
        prev = load_json(path, None)
        if prev and isinstance(prev.get("items"), list):
            return prev
    base = os.environ.get("SITE_BASE", "").rstrip("/")
    if base:
        try:
            req = urllib.request.Request(base + "/data/auto/corpus.json", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as res:
                prev = json.loads(res.read().decode("utf-8"))
            if isinstance(prev.get("items"), list):
                return prev
        except Exception as e:  # noqa: BLE001
            print(f"  prime: live fetch failed ({e}); starting fresh", file=sys.stderr)
    return {"items": [], "sources": []}


def write_archive(all_items: list[dict]) -> None:
    """Once per NZT day: write yesterday's rollup if missing (the only file
    the CI workflow ever commits)."""
    yesterday = (datetime.now(NZT) - timedelta(days=1)).date()
    path = ARCHIVE / f"{yesterday.isoformat()}.json"
    if path.exists():
        return
    day_start = int(datetime(yesterday.year, yesterday.month, yesterday.day, tzinfo=NZT).timestamp() * 1000)
    day_end = day_start + 86400_000
    day_items = [i for i in all_items if day_start <= i["published"] < day_end]
    if not day_items:
        return
    atomic_write(path, {"schema": 1, "date": yesterday.isoformat(), "items": day_items})
    print(f"  archive: wrote {path.name} ({len(day_items)} items)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="poll a single feed id, for debugging")
    ap.add_argument("--no-net-prime", action="store_true", help="skip the SITE_BASE prime fetch")
    args = ap.parse_args()

    assert_vectors()

    registry = load_json(DATA / "feeds.json", None)
    taxonomy = load_json(DATA / "topics.json", None)
    counterparts = load_json(DATA / "counterparts.json", None)
    leaders = load_json(DATA / "leaders.json", {"leaders": [], "scopes": {}})
    if not registry or not taxonomy or not counterparts:
        sys.exit("FATAL: data/feeds.json, data/topics.json or data/counterparts.json missing/invalid")

    ld_tagger = LeaderTagger(leaders)
    # Per-leader query feeds are synthesised, not written into feeds.json —
    # one registry (leaders.json) owns the leader list end to end.
    registry["feeds"] = registry["feeds"] + ld_tagger.synth_sources()
    feeds = [f for f in registry["feeds"] if not f.get("defaultOff")]
    if args.source:
        feeds = [f for f in registry["feeds"] if f["id"] == args.source]
        if not feeds:
            sys.exit(f"unknown feed id: {args.source}")

    if args.no_net_prime:
        import os
        os.environ.pop("SITE_BASE", None)

    covered = {f["domain"] for f in registry["feeds"]
               if f.get("domain") and not f.get("defaultOff") and f.get("kind") != "gnews"}

    cache = load_json(CACHE_PATH, {})
    prev = load_previous()
    prev_items = {i["id"]: i for i in prev.get("items", [])}
    prev_by_source = {s["id"]: s for s in prev.get("sources", [])}
    prev_source_items: dict[str, list] = {}
    for i in prev.get("items", []):
        prev_source_items.setdefault(i["sourceId"], []).append(i)

    tagger = Tagger(taxonomy)
    cp_tagger = CounterpartTagger(counterparts)

    paced = [f for f in feeds if f.get("pace")]
    pooled = [f for f in feeds if not f.get("pace")]

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(fetch_one, f, cache, prev_by_source): f for f in pooled}
        # Paced feeds (parliament.nz) run sequentially in this thread with gaps:
        # a 14-request burst trips Radware and blocks even the good feeds.
        for f in paced:
            results[f["id"]] = fetch_one(f, cache, prev_by_source)
            time.sleep(PARLIAMENT_GAP_S)
        for fut in concurrent.futures.as_completed(futures):
            f = futures[fut]
            results[f["id"]] = fut.result()

    now_ms = int(time.time() * 1000)
    cutoff = now_ms - WINDOW_HOURS * 3600_000
    horizon = now_ms + 6 * 3600_000  # future-date guard, matches parse.js

    merged: dict[str, dict] = {}
    for i in prev_items.values():
        if i["published"] >= cutoff:
            merged[i["id"]] = i

    ok_count = 0
    health_rows = []
    by_source = {f["id"]: f for f in registry["feeds"]}
    for sid, res in results.items():
        source = by_source[sid]
        health_rows.append(res["health"])
        if res["health"]["ok"]:
            ok_count += 1
        if res["carry"]:
            continue  # previous items for this source already in `merged`
        for raw in res["items"]:
            if raw["published"] >= horizon or raw["published"] < cutoff:
                continue
            item = finish_item(raw, source, tagger, cp_tagger, ld_tagger, cache, covered)
            if item is None:
                continue
            existing = merged.get(item["id"])
            if existing:
                # keep first-seen fetchedAt and any storyId the client assigned
                item["fetchedAt"] = existing.get("fetchedAt", item["fetchedAt"])
            merged[item["id"]] = item

    # Backfill: items carried from a pre-leaders corpus (or from 304'd feeds)
    # still get the leader pass, so the whole window is tagged from run one.
    healed = 0
    for item in merged.values():
        # Heal carried Google-remnant links. The resolver budget spreads the
        # backlog across runs; the persistent cache makes each fix permanent.
        lk = item.get("link") or ""
        if "news.google.com/rss/articles/" in lk:
            tm = GNEWS_TOKEN_RE.search(lk)
            tok = tm.group(1) if tm else ""
            real = ""
            if tok:
                with _cache_lock:
                    real = (cache.get("gnews") or {}).get(tok, "")
                if not real and _resolve_budget.acquire(blocking=False):
                    real = resolve_gnews_batch(lk, item.get("via", ""))
                    if real:
                        with _cache_lock:
                            cache.setdefault("gnews", {})[tok] = real
            if real:
                item["link"] = real
                healed += 1
        if "leaders" not in item:
            lds = ld_tagger.match(item, by_source.get(item.get("sourceId"), {}))
            if lds:
                item["leaders"] = lds
                item["scope"] = ld_tagger.scope(item, lds)
        # Untagged carried items get a fresh pass so taxonomy growth reaches
        # the whole window, not just items fetched after the change.
        if not item.get("topicTags"):
            item["topicTags"] = tagger.tag(item, item.get("sourceId", ""))
        # Carried items follow the registry's CURRENT region — a feed
        # reclassification must reach the whole window, not just new items.
        src = by_source.get(item.get("sourceId"))
        if src and item.get("region") != src.get("region", "global"):
            item["region"] = src.get("region", "global")

    # Scope gate: the bake only carries foreign news with a New Zealand nexus
    # (see taxonomy nzScope). Applied after tagging/backfill so an item can
    # earn its place through any net.
    nz_tokens = (taxonomy.get("nzScope") or {}).get("tokens", [])
    out_of_scope = [i for i in merged.values() if not in_scope(i, nz_tokens)]
    for i in out_of_scope:
        del merged[i["id"]]

    # carry health for disabled/unpolled sources so lastOk history survives
    polled = {h["id"] for h in health_rows}
    for sid, row in prev_by_source.items():
        if sid not in polled and sid in by_source:
            health_rows.append({**row, "ok": False, "status": 0, "itemCount": 0,
                                "error": row.get("error") or "not polled this run"})

    items = sorted(merged.values(), key=lambda i: i["published"], reverse=True)
    corpus = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "windowHours": WINDOW_HOURS,
        "counts": {"items": len(items), "sources": len(feeds),
                   "ok": ok_count, "failed": len(feeds) - ok_count},
        "sources": sorted(health_rows, key=lambda h: h["id"]),
        "items": items,
    }
    atomic_write(OUT_PATH, corpus)
    atomic_write(CACHE_PATH, cache)
    write_archive(items)

    size_kb = OUT_PATH.stat().st_size // 1024
    print(f"corpus: {len(items)} items from {ok_count}/{len(feeds)} feeds -> {OUT_PATH.name} ({size_kb} KB)")
    if out_of_scope:
        print(f"  scope: dropped {len(out_of_scope)} foreign items with no NZ nexus")
    if healed:
        print(f"  links: healed {healed} Google-remnant links to direct article URLs")
    for h in sorted(health_rows, key=lambda h: h["id"]):
        if not h["ok"] and h.get("error") != "not polled this run":
            print(f"  FAIL {h['id']}: {h.get('error')}")
    if ok_count == 0 and feeds:
        sys.exit("FATAL: zero feeds succeeded")


if __name__ == "__main__":
    main()
