/* corpus.js — the client end of the 20-minute pipeline. One fetch of the
   baked corpus, merged into IndexedDB by id; the device archive outlives the
   72-hour corpus window. The proxy chain (net.js) is only for live boost. */
(function () {
  const Corpus = {
    lastMeta: null, // {generatedAt, counts, sources} from the last good fetch
    lastLive: 0,    // last successful direct-feed top-up (ms)

    /* Fetch + merge. Returns {added, total, generatedAt, failed[]} or throws.
       onStage (optional) narrates the real steps for the sweep panel:
       ("fetch"), ("bake", {generatedAt, counts}), ("merge", {added, total}). */
    async sweep(onStage) {
      const stage = typeof onStage === "function" ? onStage : () => {};
      stage("fetch");
      const res = await fetch("data/auto/corpus.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("corpus fetch failed: HTTP " + res.status);
      const corpus = await res.json();
      if (!corpus || corpus.schema !== 1 || !Array.isArray(corpus.items)) {
        throw new Error("corpus.json has an unexpected shape");
      }
      stage("bake", { generatedAt: corpus.generatedAt, counts: corpus.counts });

      const existing = await Store.getAll("items");
      const known = new Map(existing.map((i) => [i.id, i]));
      const gist = (i) => i.title + "\u0000" + (i.summary || "") + "\u0000" +
        JSON.stringify([i.topicTags, i.counterparts, i.leaders, i.scope, i.region, i.link]);
      const fresh = [];
      const toWrite = [];
      for (const item of corpus.items) {
        if (!item || !item.id || !item.title) continue;
        const prev = known.get(item.id);
        if (!prev) {
          fresh.push(item);
          toWrite.push(item);
        } else if (gist(prev) !== gist(item)) {
          // Re-bakes update summaries/tags; local fields the client owns
          // (storyId from clustering, first-seen stamp) must survive. Items
          // that haven't changed are not rewritten — 1,500 IndexedDB writes
          // every 20 minutes was pure churn.
          toWrite.push({ ...item, storyId: prev.storyId || null, fetchedAt: prev.fetchedAt || item.fetchedAt });
        }
      }
      await Store.putMany("items", toWrite);
      if (fresh.length) await Store.pruneItems();
      stage("merge", { added: fresh.length, total: corpus.items.length });

      Corpus.lastMeta = { generatedAt: corpus.generatedAt, counts: corpus.counts, sources: corpus.sources };
      await Store.kvSet("corpusMeta", Corpus.lastMeta);
      await Store.kvSet("lastSweep", Date.now());
      return {
        added: fresh.length,
        total: toWrite.length,
        generatedAt: corpus.generatedAt,
        failed: (corpus.sources || []).filter((s) => !s.ok).map((s) => s.id),
        freshItems: fresh,
      };
    },

    async restoreMeta() {
      if (!Corpus.lastMeta) Corpus.lastMeta = await Store.kvGet("corpusMeta", null);
      if (!Corpus.lastLive) Corpus.lastLive = await Store.kvGet("corpusLive", 0);
      return Corpus.lastMeta;
    },

    /* Currency for the masthead pill. The wire is as fresh as the NEWEST of
       (a) the baked corpus and (b) the last successful direct top-up — the
       bake going stale (baker asleep, cron slipped, local dev) no longer
       means the wire is stale, because sweeps top up direct. bakeAgeMin is
       kept separately so the sweep panel can be honest about the bake. */
    freshness() {
      const gen = Corpus.lastMeta && Corpus.lastMeta.generatedAt ? Date.parse(Corpus.lastMeta.generatedAt) : 0;
      const current = Math.max(gen, Corpus.lastLive || 0);
      const bakeAgeMin = gen ? Math.max(0, Math.round((Date.now() - gen) / 60000)) : Infinity;
      if (!current) return { label: "No data yet", cls: "dead", ageMin: Infinity, bakeAgeMin };
      const ageMin = Math.max(0, Math.round((Date.now() - current) / 60000));
      const cls = ageMin > 90 ? "dead" : ageMin > 45 ? "stale" : "";
      const word = (Corpus.lastLive || 0) > gen ? "Live" : "Updated";
      const label = ageMin < 1 ? word + " just now" : ageMin < 60 ? word + " " + ageMin + " min ago" : word + " " + Math.round(ageMin / 60) + " h ago";
      return { label, cls, ageMin, bakeAgeMin };
    },

    /* Direct-feed top-up through net.js (direct where CORS allows, proxy
       chain otherwise). Runs automatically when the bake is stale so the
       wire stays current even when the baker doesn't; still available as a
       manual button. Non-gnews tier-1/2 feeds only. */
    async liveBoost(settings, onProgress) {
      const progress = typeof onProgress === "function" ? onProgress : () => {};
      const sources = Sources.all(settings).filter((s) =>
        Sources.enabled(s, settings) && s.kind !== "gnews" && (s.tier || 2) <= 2);
      const existing = new Set((await Store.getAll("items")).map((i) => i.id));
      const freshItems = [];
      let done = 0, ok = 0;
      const tasks = sources.map((src) => async () => {
        try {
          const { text, via } = await Net.fetchFeed(src); // returns {text, via}
          const items = Parse.feed(text, src);
          ok++;
          for (const item of items) {
            if (existing.has(item.id)) continue;
            item.topicTags = Fatopics.tag(item, src.id);
            // Content that arrived through a public proxy never gets the
            // primary-document marker: the middleman is not a primary source.
            if (via !== "direct" && via !== "native" && item.tier === 1) item.tier = 2;
            existing.add(item.id);
            freshItems.push(item);
          }
        } catch (e) {
          Net.markBad(src.id, e);
        } finally {
          done++;
          progress(done, sources.length, freshItems.length);
        }
      });
      await Net.pool(tasks, 6);
      if (freshItems.length) {
        await Store.putMany("items", freshItems);
        await Store.pruneItems();
      }
      if (ok > 0) {
        Corpus.lastLive = Date.now();
        await Store.kvSet("corpusLive", Corpus.lastLive);
      }
      return { added: freshItems.length, polled: sources.length, ok };
    },
  };

  window.Corpus = Corpus;
})();
