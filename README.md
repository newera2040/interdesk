# InterDesk

**For Vanushi Walters · Foreign Affairs Desk.** A mobile-first news aggregate and
tracker for the Foreign Affairs portfolio (and its NZSIS/GCSB oversight brief):
NZ, Pacific and great-power coverage baked fresh every ~20 minutes, a clean
phone reader with highlighting and read-tracking for the spokesperson, and a
desk mode for the comms team to pin stories, attach steers, and track her
opposite numbers in government alongside the key world leaders.

Zero-build vanilla JS + stdlib Python. No Node, no bundler, no framework.
Sibling of The Gallery (`../newsroom`).

## Run it locally

```
python3 tools/serve.py            # http://localhost:8793
python3 tools/poller.py           # bake data/auto/corpus.json from ~46 live feeds
python3 tools/relay-dev.py        # optional: pins/notes relay on 8795 (dev keys reader-dev / writer-dev)
```

Front door PIN: ask the desk. Desk mode: Settings → Desk → paste the write key.

## How it fits together

- **Corpus (read-only truth).** `tools/poller.py` polls `data/feeds.json`
  (74 registered sources, 39 on: Beehive per-portfolio feeds, RNZ, Pacific
  mastheads, wires, think tanks, Google News query trackers), tags items
  against `data/topics.json` (12 deterministic topics) and
  `data/counterparts.json` (who authored / who it's about), and writes a
  rolling 72-hour `data/auto/corpus.json`. In production a GitHub Actions cron
  (`.github/workflows/poll-and-deploy.yml`) does this every ~20 minutes and
  redeploys the site — no data commits; the poller re-primes from the live
  site each run. The phone fetches ONE json instead of 46 feeds.
- **Relay (shared desk state).** A tiny Cloudflare Worker
  (`tools/relay-worker.js`) holds pins, per-story desk notes
  and response flags in KV behind two bearer keys: READ (her phone, the CI
  poller) and WRITE (the desk). See DEPLOY.md for the 5-minute setup.
- **Device (private).** Her read-state, saves, highlights, mutes and lens live
  in IndexedDB on her phone only. They never touch a server; the Share pack
  (Saved → SHARE PACK) is the deliberate, file-based way to send highlights
  back to the desk. Read receipts are deliberately impossible: the reader key
  cannot write.

## About the PIN

The 4-digit PIN is a privacy screen, not content security. It is checked
entirely in the browser against a salted hash, and because this is a public
static site, anyone technical can extract or bypass it in seconds — the same
way a frosted glass door stops glances but not burglars. It exists to stop
shoulder-surfing, casual discovery of the URL, and someone idly opening the
app on a borrowed or unattended phone. The things that actually matter are
protected elsewhere: shared pins and desk notes require bearer tokens verified
by the relay server, and those tokens can be rotated at the relay if a device
is ever lost or stolen — do that first, before worrying about the PIN. Never
reuse a banking or device passcode as this PIN.

**Lost phone procedure:** Cloudflare dashboard → the interdesk-relay Worker →
Settings → Variables and Secrets → replace READ_KEY (and WRITE_KEY if it was a
desk device) → redeploy → re-enter keys on the remaining devices. Done; the
lost device now holds nothing that works.

## The Portfolio space

Tracks her opposite portfolio holders (verified 3 Aug 2026, post the April
2026 reshuffle): **Peters** (Foreign Affairs), **Penk** (Defence + NZSIS +
GCSB), **McClay** (Trade + sole Associate FM), **Luxon** (National Security &
Intelligence hat only), with Mitchell and Goldsmith registered but off.
Releases and speeches arrive from live-verified Beehive taxonomy feeds;
coverage from per-person query feeds and coverage tagging. Every file opens
with their **verified socials, most-active channel first** — there is no
workable free X feed in 2026 (API dead, Nitter dead, bridges need servers and
logins), so posts are read at the source via those links, and post-driven
coverage arrives through the query feeds within hours. Flag any counterpart
item "needs response" and work the queue on the Desk view.

**The whole registry expires on election day (7 Nov 2026).** Holders, feeds
and handles must be re-verified after government formation — the app nags
from late October.

## AI features (bring your own key)

With an Anthropic API key in Settings: a morning **Brief** structured for an
FA spokesperson, **Explain** backgrounders on any story, and the Deskroom's
daily **Desk draft**. Every surface has a deterministic local twin that
compiles from the archive with receipts. No key, no problem; nothing
auto-runs.

## Repo map

```
index.html            app shell + PIN gate (gate CSS inlined for first paint)
css/style.css         wire-terminal tokens, one file
js/                   gate, store (IndexedDB), corpus, sources, fatopics,
                      cluster, parse, net (live-boost proxies), relay, charts,
                      search, fadata (verified reference), ai, local, ui, app
data/feeds.json       THE registry (poller + client share it)
data/topics.json      12-topic taxonomy, seeds included
data/counterparts.json  her opposite numbers + match rules
data/auto/            baked corpus + daily archive (CI-generated)
tools/poller.py       the 20-minute baker (stdlib only)
tools/relay-worker.js Cloudflare Worker (paste-in)
tools/relay-dev.py    local relay twin (8795)
tools/serve.py        dev server (8793)
tools/test-vectors.json  FNV id parity, asserted at poller startup
.github/workflows/poll-and-deploy.yml   the cron + Pages deploy
```
