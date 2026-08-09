/* net.js — feed fetching through a CORS-proxy fallback chain.
   Most NZ feeds don't send Access-Control-Allow-Origin, so a static browser
   app needs a proxy. We keep a chain of public proxies, remember per-source
   which one worked last (sticky), and fail over automatically. */
(function () {
  // Ordered fallback chain, live-tested 27 Jul 2026:
  //   corsfix     — fastest, byte-identical XML, 60 req/min, free for localhost
  //   allorigins  — byte-identical but flaky under load (fall through on 4xx/5xx)
  //   cors.sh     — byte-identical, ACAO:*, keyless (path-style, raw URL)
  //   corsproxy   — works from real browser fetches on localhost (403s curl)
  // codetabs (upstream 522) and cors.eu.org (instant 429) are dead — excluded.
  // encode:false means the raw URL is appended without encodeURIComponent.
  const PROXIES = [
    { id: "corsfix", template: "https://proxy.corsfix.com/?{url}", encode: false },
    { id: "allorigins", template: "https://api.allorigins.win/raw?url={url}", encode: true },
    { id: "cors-sh", template: "https://proxy.cors.sh/{url}", encode: false },
    { id: "corsproxy", template: "https://corsproxy.io/?url={url}", encode: true },
  ];

  const sticky = {}; // sourceId -> proxy id that last worked
  const health = {}; // sourceId -> {ok, at, via, error}

  function proxied(proxy, url) {
    return proxy.template.replace("{url}", proxy.encode ? encodeURIComponent(url) : url);
  }

  async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (!text || text.length < 40) throw new Error("empty response");
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  function looksLikeFeed(text) {
    const head = text.slice(0, 600).trimStart();
    return (
      head.startsWith("<") &&
      (head.includes("<rss") || head.includes("<feed") || head.includes("<rdf:RDF") ||
       head.includes("<?xml") || head.includes("<channel"))
    ) || head.startsWith("{"); // JSON feed
  }

  /* Native shell bridge: the iOS app exposes a URLSession fetch with no CORS,
     so feeds skip the public proxy middlemen entirely. Rejections carry the
     native error message and flow into the same per-attempt failover as any
     proxy failure; the chain below remains the fallback. */
  function nativeBridge() {
    return (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.nativeFetch) || null;
  }

  async function nativeFetch(url) {
    const text = await nativeBridge().postMessage(url);
    if (!text || text.length < 40) throw new Error("empty response");
    return text;
  }

  const Net = {
    /* Fetch a feed URL for a source. source: {id, url, cors} */
    async fetchFeed(source, { timeout = 16000 } = {}) {
      const attempts = [];

      // Native app first (no CORS at all), then direct where allowed.
      if (nativeBridge()) attempts.push({ id: "native", url: source.url });

      // Direct first when the origin is known to allow CORS.
      if (source.cors) attempts.push({ id: "direct", url: source.url });

      // Sticky proxy first, then the rest of the chain.
      const order = [...PROXIES];
      const stickyId = sticky[source.id];
      if (stickyId) order.sort((a, b) => (a.id === stickyId ? -1 : b.id === stickyId ? 1 : 0));
      order.forEach((p) => attempts.push({ id: p.id, url: proxied(p, source.url) }));

      let lastErr = null;
      for (const attempt of attempts) {
        try {
          const text = attempt.id === "native"
            ? await nativeFetch(attempt.url)
            : await fetchWithTimeout(attempt.url, timeout);
          if (!looksLikeFeed(text)) throw new Error("not a feed payload");
          sticky[source.id] = attempt.id === "direct" ? stickyId : attempt.id;
          health[source.id] = { ok: true, at: Date.now(), via: attempt.id };
          return { text, via: attempt.id };
        } catch (err) {
          lastErr = err;
        }
      }
      health[source.id] = { ok: false, at: Date.now(), error: String(lastErr && lastErr.message || lastErr) };
      throw lastErr || new Error("all fetch attempts failed");
    },

    /* Record a downstream (e.g. parse) failure against a source and clear its
       sticky proxy so the next sweep tries a different route. */
    markBad(sourceId, err) {
      delete sticky[sourceId];
      health[sourceId] = { ok: false, at: Date.now(), error: String((err && err.message) || err) };
    },

    health() {
      return health;
    },

    healthSummary() {
      const entries = Object.values(health);
      if (!entries.length) return { level: "unknown", ok: 0, bad: 0 };
      const ok = entries.filter((e) => e.ok).length;
      const bad = entries.length - ok;
      const level = bad === 0 ? "good" : bad <= entries.length / 3 ? "warn" : "bad";
      return { level, ok, bad };
    },

    /* Run tasks with limited concurrency. tasks: array of () => Promise */
    async pool(tasks, limit = 6) {
      const results = new Array(tasks.length);
      let next = 0;
      async function worker() {
        while (next < tasks.length) {
          const i = next++;
          try {
            results[i] = { ok: true, value: await tasks[i]() };
          } catch (err) {
            results[i] = { ok: false, error: err };
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
      return results;
    },
  };

  window.Net = Net;
})();
