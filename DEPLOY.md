# Deploying InterDesk

Three one-time setups: the GitHub repo (hosting + the 20-minute baker), the
Cloudflare relay (pins/notes/response flags), and the phones. ~20 minutes total.

## 1. GitHub Pages + the poller cron

1. Create a **public** repo (public = free unlimited Actions minutes — the
   cron burns ~3,600 min/month, which would bust a private repo's 2,000 cap).
   Give it a neutral name (`interdesk`); the site is noindex + robots-blocked.
2. Push this folder to `main` **with a fresh history** — early local
   commits contain a real key value: `git checkout --orphan release &&
   git add -A && git commit -m "InterDesk" && git push origin release:main`.
3. Settings → Pages → Source: **GitHub Actions**.
4. Actions tab → "Poll feeds and deploy" → **Run workflow** (twice — the
   second run proves the corpus self-primes off the live site).

The site lands at `https://<user>.github.io/<repo>/`.

Notes:
- The cron runs at :07/:27/:47 NZ daytime and hourly overnight; GitHub cron
  slips 3–15 minutes under load, which is why the app shows "UPD 14M AGO"
  instead of promising a cadence.
- **Timezone caveat:** cron is UTC. The dense window is set for NZST; when
  daylight saving starts (late Sept) it drifts an hour later in local terms.
  Accepted; hand-shift the hour ranges in the workflow if it ever matters.
- The only recurring commit is a small daily archive rollup. The corpus
  itself ships in the deploy artifact, never the git history.

## 2. The relay (Cloudflare Worker, free tier)

1. dash.cloudflare.com → Workers & Pages → Create → Worker → deploy the
   hello-world, then Edit code and replace it with `tools/relay-worker.js`.
2. Storage & Databases → KV → Create namespace, call it `DESK`.
3. The Worker → Settings → Bindings → Add → KV namespace → variable name
   `DESK` → your namespace.
4. Settings → Variables and Secrets → add two **Secrets**:
   `READ_KEY` — a long random string (`openssl rand -hex 24`) — and
   `WRITE_KEY` — the desk key the team agreed on. Redeploy when prompted.
   (The write key is what desk mode unlocks with; it can be rotated here
   any time. Never write the real value into any file in this repo — the
   repo is public.)
5. Key distribution:
   - **Her phone, once:** Settings → Connections → relay URL + the READ key.
   - **Desk devices, every session:** the same, plus Settings → Desk → the
     WRITE key. The desk key is deliberately never stored on a device —
     it unlocks desk mode for the current session only and is re-entered
     each time the app opens.

The worker also serves an unauthenticated `GET /time` returning only the
edge's clock — the masthead clock syncs against it (Cloudflare edges are
NTP-disciplined and terminate a few milliseconds from the reader). It
exposes no desk data and needs no key.

If a phone is lost: replace the relevant secret in the dashboard, redeploy,
re-enter on remaining devices. That's the whole revocation story.

## 3. Phones

Open the Pages URL in Safari → Share → **Add to Home Screen**. The app is a
PWA: standalone chrome, offline shell, the last corpus readable in flight
mode. The PIN gate fronts every open (Settings → Reading → "Require PIN"
controls how often; default re-locks after an hour away).

## Local development

```
python3 tools/serve.py          # app on 8793 (no-store headers)
python3 tools/relay-dev.py      # relay twin on 8795 (dev keys reader-dev / writer-dev; set WRITE_KEY=… to match production)
python3 tools/poller.py         # bake a real corpus locally
```

Serving app and relay on different ports is deliberate: relay calls are
genuinely cross-origin, so CORS + Authorization get exercised exactly as in
production.

## Maintenance rules

- **`?v=` cache-busters in index.html and `VERSION`/`Q` in sw.js move in
  lockstep.** Bump both on any asset change or Home Screen apps serve stale
  code.
- The PIN's salted hash lives in `js/gate.js` (`EXPECTED`). To change the PIN:
  `printf 'interdesk.gate.v1|NEWPIN' | shasum -a 256`, paste the hex, bump the
  cache-busters.
- **After the 7 Nov 2026 election: re-verify everything** — every counterpart,
  every Beehive taxonomy term, every handle, the fadata reference block. The
  registries carry `reviewBy` fields and the app nags from late October.
- Feed rot: `data/feeds.json` notes which feeds are challenge-prone
  (`transientChallenge`) — the poller carries their items through misses, so
  a bot-wall blip never empties a source. A feed dead for good: flip it to a
  Google News `site:` query like the existing `gn-*` entries.
