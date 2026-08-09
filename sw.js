/* sw.js — network-first shell cache so the desk opens in flight mode.
   VERSION must be bumped in lockstep with the ?v= suffixes in index.html —
   same rule as the rest of the estate (see DEPLOY.md).

   data/auto/corpus.json is network-first WITH cache fallback: fresh always
   wins online, the last bake still reads offline. Never cache-first. */
const VERSION = "interdesk-v6";
const Q = "?v=6";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css" + Q,
  "js/gate.js" + Q,
  "js/store.js" + Q,
  "js/net.js" + Q,
  "js/relay.js" + Q,
  "js/parse.js" + Q,
  "js/cluster.js" + Q,
  "js/fatopics.js" + Q,
  "js/fadata.js" + Q,
  "js/sources.js" + Q,
  "js/charts.js" + Q,
  "js/corpus.js" + Q,
  "js/clock.js" + Q,
  "js/local.js" + Q,
  "js/ai.js" + Q,
  "js/ui.js" + Q,
  "js/app.js" + Q,
  "data/feeds.json",
  "data/topics.json",
  "data/counterparts.json",
  "fonts/MonaSans.woff2",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).catch(() => { /* partial cache is fine */ }));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // proxies, api.anthropic.com, relay: untouched
  // Cache-busted corpus URLs must not pile up one entry per sweep: store the
  // corpus under its clean pathname, everything else under its request URL.
  const cacheKey = url.pathname.endsWith("corpus.json") ? url.pathname : e.request;
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(cacheKey, copy)).catch(() => {});
      return res;
    }).catch(() =>
      caches.match(cacheKey).then((hit) => hit || caches.match("index.html")))
  );
});
