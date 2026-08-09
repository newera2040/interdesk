/* relay-worker.js — InterDesk's reader/desk relay.
   Paste this whole file into a Cloudflare Worker via the dashboard editor
   (no CLI needed). Setup, once:
     1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> deploy
        the hello-world, then Edit code and replace it with this file.
     2. Storage & Databases -> KV -> Create namespace (call it DESK).
     3. The Worker -> Settings -> Bindings -> Add -> KV namespace ->
        variable name DESK -> your namespace.
     4. Settings -> Variables and Secrets -> Add -> type Secret, twice:
          name READ_KEY  -> a long random string
          name WRITE_KEY -> a different long random string
        Redeploy when prompted.
     5. Give the workers.dev URL + READ_KEY to the reader's phone and the
        CI poller; give the URL + WRITE_KEY to the desk. Each device enters
        them in its Settings.

   API (all JSON). Auth: Authorization: Bearer <key> on every request.
   GET endpoints accept READ_KEY or WRITE_KEY; PUT/DELETE require WRITE_KEY.
     GET    /state        -> {generated, pins, notes, responds, meta}
     PUT    /pins/:id     -> body <=4096B, id ^i[a-z0-9]{1,20}$,
                             TTL = body.ttlSeconds clamped [1h, 30d], default 7d
     PUT    /notes/:id    -> body <=2048B, id ^i[a-z0-9]{1,20}$, TTL 60d
     PUT    /respond/:id  -> body <=2048B, id ^i[a-z0-9]{1,20}$, TTL 60d
                             (TTL renews on every PUT — marking an item
                             responded just re-PUTs the flag)
     PUT    /meta/desk    -> body <=1024B, TTL 30d
     PUT    /desk          -> the shipped desk page {html, title, date, shippedAt},
                              body <=32768B, TTL 60d (re-shipped daily)
     DELETE /pins/:id, /notes/:id, /respond/:id, /meta/desk, /desk

   Design notes:
   - One KV key per record: concurrent writes can never clobber each other.
     Everything expires server-side (expirationTtl), renewed by re-PUTting;
     nothing accumulates.
   - /state assembles everything a device renders in one call. A cache miss
     costs ONE unprefixed KV list() bucketed in-worker (a single desk sits
     well under one 1,000-key list page) — cheaper against the KV free
     tier's 1,000 list()/day than a list per prefix (4x the ops for the
     and costs one prefixed list per miss.
   - Both GETs are edge-cached 120s at synthetic constant URLs, written
     only AFTER auth passes, so the cache can never leak to or be poisoned
     by unauthenticated callers. Every pin/note/respond/meta write purges
     The 120s floor bounds each endpoint at ~720 lists/day per colo even
     under pathological cold polling; the real cadence (one desk, one
     phone, a CI poller every few minutes, all hitting one colo's warm
     cache) sits in the low hundreds, far inside the budget. */

const DAY = 86400;
const STATE_CACHE = "https://desk.internal/state";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};

/* Per-namespace contract: KV prefix, id shape, body cap, which body fields
   must line up with the path (bad-flag style), which GET cache a write
   invalidates, and the record's TTL. Ids are the app's content-derived
   hashes: "i" + base36 for wire items. */
const NS = {
  pins:     { prefix: "pin:",  id: /^i[a-z0-9]{1,20}$/,    max: 4096, idField: "itemId", strField: "title", cache: STATE_CACHE, ttl: pinTtl },
  notes:    { prefix: "note:", id: /^i[a-z0-9]{1,20}$/,    max: 2048, idField: "itemId", strField: "text",  cache: STATE_CACHE, ttl: () => 60 * DAY },
  respond:  { prefix: "resp:", id: /^i[a-z0-9]{1,20}$/, max: 2048, idField: "itemId", strField: null,    cache: STATE_CACHE, ttl: () => 60 * DAY },
};

function pinTtl(body) {
  const t = Number(body && body.ttlSeconds);
  if (!Number.isFinite(t)) return 7 * DAY; // a pin is news, not a filing system
  return Math.min(30 * DAY, Math.max(3600, Math.round(t)));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function cachedList(env, ctx, cacheUrl, build) {
  const cache = caches.default;
  const hit = await cache.match(cacheUrl);
  if (hit) return new Response(hit.body, hit);
  const payload = JSON.stringify(await build());
  ctx.waitUntil(cache.put(cacheUrl, new Response(payload, {
    headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=120", ...CORS },
  })));
  return new Response(payload, { headers: { "Content-Type": "application/json", ...CORS } });
}

export default {
  async fetch(req, env, ctx) {
    // Fail closed: a worker deployed before its secrets exist must refuse to
    // serve — otherwise "Bearer undefined" would literally authenticate.
    if (!env.READ_KEY || !env.WRITE_KEY) {
      return new Response(JSON.stringify({ error: "relay not configured" }),
        { status: 503, headers: { "Content-Type": "application/json", ...CORS } });
    }
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    // Public time beacon: returns only the edge's NTP-disciplined clock,
    // terminating a few milliseconds from the reader. No desk data, no auth,
    // never cached — the client halves the round trip to estimate its offset.
    if (req.method === "GET" && new URL(req.url).pathname.replace(/\/+$/, "") === "/time") {
      return new Response(JSON.stringify({ now: Date.now() }),
        { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS } });
    }

    const auth = req.headers.get("Authorization") || "";
    const canWrite = auth === "Bearer " + env.WRITE_KEY;
    const canRead = canWrite || auth === "Bearer " + env.READ_KEY;
    if (req.method === "GET" ? !canRead : !canWrite) {
      return json({ error: "unauthorized" }, 401);
    }

    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    if (req.method === "GET" && path === "/state") {
      return cachedList(env, ctx, STATE_CACHE, async () => {
        const { keys } = await env.DESK.list(); // the one list this endpoint pays for
        const names = keys.map((k) => k.name).filter((n) => !n.startsWith("cap:"));
        const vals = await Promise.all(names.map((n) => env.DESK.get(n, "json")));
        const state = { generated: new Date().toISOString(), pins: [], notes: [], responds: [], meta: null, desk: null };
        names.forEach((n, i) => {
          const v = vals[i];
          if (v == null) return;
          if (n.startsWith("pin:")) state.pins.push(v);
          else if (n.startsWith("note:")) state.notes.push(v);
          else if (n.startsWith("resp:")) state.responds.push(v);
          else if (n === "meta:desk") state.meta = v;
          else if (n === "deskpage:current") state.desk = v;
        });
        return state;
      });
    }


    // Per-record routes: /<ns>/<id>, plus the meta singleton.
    let ns = null, id = null;
    if (path === "/meta/desk") {
      ns = { prefix: "meta:", max: 1024, idField: null, strField: null, cache: STATE_CACHE, ttl: () => 30 * DAY };
      id = "desk";
    } else if (path === "/desk") {
      ns = { prefix: "deskpage:", max: 32768, idField: null, strField: "html", cache: STATE_CACHE, ttl: () => 60 * DAY };
      id = "current";
    } else {
      const m = path.match(/^\/(pins|notes|respond)\/([a-z0-9]+)$/);
      if (m && NS[m[1]].id.test(m[2])) { ns = NS[m[1]]; id = m[2]; }
    }
    if (!ns) return json({ error: "not found" }, 404);
    const key = ns.prefix + id;

    if (req.method === "PUT") {
      let body;
      try { body = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
      if (!body || typeof body !== "object"
          || (ns.idField && body[ns.idField] !== id)
          || (ns.strField && typeof body[ns.strField] !== "string")) {
        return json({ error: "bad record" }, 400);
      }
      const text = JSON.stringify(body);
      if (text.length > ns.max) return json({ error: "too big" }, 413);
      await env.DESK.put(key, text, { expirationTtl: ns.ttl(body) });
      ctx.waitUntil(caches.default.delete(ns.cache));
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      await env.DESK.delete(key);
      ctx.waitUntil(caches.default.delete(ns.cache));
      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
  },
};
