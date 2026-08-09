/* fatopics.js — the JS twin of the poller's topic tagger. Same taxonomy file,
   same normalisation, same scoring, so an item tagged client-side (live boost)
   matches what the corpus would have said. Keep in lockstep with
   tools/poller.py Tagger — the rules live in data/topics.json, only the
   mechanics are duplicated here. */
(function () {
  let taxonomy = null;

  const MACRONS = { "ā": "a", "ē": "e", "ī": "i", "ō": "o", "ū": "u", "Ā": "a", "Ē": "e", "Ī": "i", "Ō": "o", "Ū": "u" };

  function normalise(text) {
    let t = String(text || "").replace(/[āēīōūĀĒĪŌŪ]/g, (m) => MACRONS[m]);
    // Possessives first, in any apostrophe form: stripping the apostrophe
    // before the 's rule turns "Trump's" into "trumps", which then misses a
    // word-boundary "trump" seed. KEEP IN LOCKSTEP with poller.py normalise.
    t = t.replace(/['’ʻˈ`]s\b/gi, "");
    t = t.replace(/[ʻ'’ˈ`]/g, "");
    t = t.toLowerCase().replace(/'s\b/g, "");
    return t.replace(/\s+/g, " ");
  }

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function wordHit(seed, text) {
    if (seed.indexOf(" ") >= 0 || seed.indexOf("-") >= 0) return text.indexOf(seed) >= 0;
    return new RegExp("\\b" + esc(seed) + "\\b").test(text);
  }

  function casedHit(seed, raw) {
    return new RegExp("\\b" + esc(seed) + "\\b").test(raw);
  }

  const Fatopics = {
    async load() {
      taxonomy = await fetch("data/topics.json", { cache: "no-store" }).then((r) => r.json());
      return taxonomy;
    },

    list() { return taxonomy ? taxonomy.topics : []; },
    label(id) {
      const t = taxonomy && taxonomy.topics.find((x) => x.id === id);
      return t ? t.label : id;
    },

    tag(item, sourceId) {
      if (!taxonomy) return item.topicTags || [];
      const s = taxonomy.scoring;
      const titleN = normalise(item.title);
      const summaryN = normalise((item.summary || "").slice(0, s.summaryChars));
      const titleRaw = item.title || "";
      const summaryRaw = (item.summary || "").slice(0, s.summaryChars);
      const scores = {};

      for (const topic of taxonomy.topics) {
        let score = 0;
        for (const seed of topic.seeds || []) {
          if (wordHit(seed, titleN)) score += s.title;
          else if (wordHit(seed, summaryN)) score += s.summary;
        }
        for (const seed of topic.cased || []) {
          if (casedHit(seed, titleRaw)) score += s.title;
          else if (casedHit(seed, summaryRaw)) score += s.summary;
        }
        for (const pair of topic.compounds || []) {
          const both = titleN + " " + summaryN;
          if (wordHit(pair[0], both) && wordHit(pair[1], both)) score += s.title;
        }
        if (score >= s.threshold) scores[topic.id] = score;
      }

      for (const topic of taxonomy.topics) {
        if (topic.require && scores[topic.id] !== undefined && scores[topic.require] === undefined) {
          delete scores[topic.id];
        }
      }

      for (const forced of (taxonomy.sourceTags || {})[sourceId] || []) {
        if (scores[forced] === undefined) scores[forced] = s.threshold;
      }

      const keep = new Set(s.alwaysKeep || []);
      const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a] || (a < b ? -1 : 1));
      const capped = new Set(ranked.filter((t) => keep.has(t)).concat(ranked.filter((t) => !keep.has(t)).slice(0, s.maxTags)));
      return ranked.filter((t) => capped.has(t));
    },

    /* The wire's foreign-news scope (taxonomy nzScope): foreign items must be
       significant to, related to, or concern New Zealand and its interests.
       Domestic, official and Pacific items always pass; global and analysis
       items need a topic tag, a tracked person, or an NZ-nexus token. The
       device-side twin of poller.py in_scope — items already stored before a
       scope change age out of view here without waiting for a rebake. */
    inScope(item) {
      if (!taxonomy || !taxonomy.nzScope) return true;
      const r = item.region;
      if (r === "nz" || r === "official" || r === "pacific") return true;
      if ((item.topicTags || []).length) return true;
      if ((item.counterparts || []).length || (item.leaders || []).length) return true;
      const text = normalise((item.title || "") + " " + String(item.summary || "").slice(0, 300));
      return (taxonomy.nzScope.tokens || []).some((t) => wordHit(t, text));
    },
  };

  window.Fatopics = Fatopics;
})();
