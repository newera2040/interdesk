/* cluster.js — Stage A: heuristic clustering. Groups duplicate/related wire
   items with no API cost, and pre-groups new items for the AI editorial pass. */
(function () {
  const STOP = new Set(("a,an,the,and,or,but,of,in,on,at,to,for,with,by,from,as,is,are,was,were,be,been," +
    "has,have,had,will,would,could,should,new,says,say,said,after,over,under,into,amid,more,less,not,no," +
    "up,down,out,off,its,it,his,her,their,our,your,my,this,that,these,those,how,what,why,when,where,who," +
    "nz,zealand,zealands,news,live,update,updates,watch,revealed,report").split(","));

  /* Capitalised but useless as a filing label. */
  const TOPIC_STOP = new Set(("time,new,news,people,report,update,breaking,exclusive,live,watch,video,opinion," +
    "editorial,analysis,explainer,review,podcast,photos,gallery,full,read,listen,today,yesterday,tomorrow," +
    "one,two,three,first,last,next,more,most,best,worst,big,long,short,here,there,this,that,what,who,when," +
    "where,why,how,man,woman,men,women,family,home,life,work,day,week,month,year,world,country,state,city," +
    "government,minister,police,health,school,court,council,report,study,survey,poll,plan,deal,move,call," +
    "top,new zealand,kiwi,kiwis," +
    // Weekdays and months are dates, not subjects ("Daily progress for Tuesday").
    "monday,tuesday,wednesday,thursday,friday,saturday,sunday," +
    "january,february,march,april,june,july,august,september,october,november,december").split(","));

  const FUNCTION_WORDS = new Set(("to,and,or,but,of,in,on,at,for,with,by,from,as,if,is,are,was,were,be," +
    "the,a,an,that,this,into,over,under,after,before,than,then,when,while,about,against,between").split(","));

  /* Ids unique by construction: regroupArchive mints hundreds of storylines
     inside one synchronous loop, where a millisecond stamp plus a 1-in-10,000
     random draw collides and silently merges two unrelated clusters. */
  const ID_SALT = Math.random().toString(36).slice(2, 8);
  let idSeq = 0;
  function mintId(prefix) {
    return prefix + Date.now().toString(36) + ID_SALT + (idSeq++).toString(36);
  }

  function tokens(str) {
    return (str || "")
      .toLowerCase()
      .replace(/['’]/g, "")
      .split(/[^a-zāēīōū0-9$%]+/)
      .filter((w) => w.length > 2 && !STOP.has(w));
  }

  // Proper-noun-ish entities: capitalised runs plus $-amounts.
  function entities(str) {
    const out = new Set();
    for (const ent of entityList(str)) out.add(ent.toLowerCase());
    return out;
  }

  /* Same matcher, preserving original case so it can be shown to the reader. */
  function entityList(str) {
    const out = [];
    const re = /(?:[A-ZĀĒĪŌŪ][a-zāēīōūA-ZĀĒĪŌŪ'’-]+(?:\s+[A-ZĀĒĪŌŪ][a-zāēīōū'’-]+)*)|\$[\d.,]+[bmk]?/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      const ent = m[0].trim();
      if (ent.length > 3 && !STOP.has(ent.toLowerCase())) out.push(ent);
    }
    return out;
  }

  /* A short label naming what the cluster is *about*, so a run of updates reads
     as one continuing story rather than a pile of separate headlines.

     The hard part is that a headline's first word is capitalised whether or not
     it is a proper noun ("Another totara has fallen", "Government advertised
     ..."). A single-word candidate therefore has to prove itself: it must turn
     up somewhere other than the start of a headline, or in more than one item.
     Multi-word names ("Green Party", "Reserve Bank") need no such proof. */
  function topicFor(items) {
    const counts = new Map();
    for (const item of items) {
      const title = item.title || "";
      const seen = new Map();
      for (const raw of entityList(title)) {
        // Strip possessives and any trailing punctuation the matcher caught.
        const ent = raw.replace(/[’']s\b/gi, "").replace(/[’'`\-–—,.:;]+$/, "").trim();
        if (ent.length < 4) continue;
        const key = ent.toLowerCase();
        // Title-initial only counts as "unproven" evidence.
        const initial = title.indexOf(raw) === 0;
        const prev = seen.get(key);
        seen.set(key, { label: ent, initialOnly: prev ? prev.initialOnly && initial : initial });
      }
      // Count each entity once per item so one verbose headline can't dominate.
      for (const [key, rec] of seen) {
        const acc = counts.get(key) || { label: rec.label, n: 0, midSentence: 0, words: rec.label.split(/\s+/).length };
        acc.n++;
        if (!rec.initialOnly) acc.midSentence++;
        if (rec.label.length > acc.label.length) acc.label = rec.label;
        counts.set(key, acc);
      }
    }

    const ranked = [...counts.values()]
      // 5 words is enough for the longest real names ("Ngāti Hei Claims
      // Settlement Bill") without admitting whole headlines.
      .filter((r) => r.label.length <= 34 && r.words <= 5)
      // Some wires (Scoop) publish Title Case headlines, where every word is
      // capitalised and the matcher swallows a whole sentence as one "name".
      // A real name written normally never capitalises its function or filler
      // words, so their presence past the first word marks a sentence.
      .filter((r) => !r.label.split(/\s+/).slice(1)
        .some((w) => { const lw = w.toLowerCase(); return FUNCTION_WORDS.has(lw) || STOP.has(lw); }))
      // Gate: prove it is a name, not just a capitalised word.
      .filter((r) => r.words > 1 || r.midSentence > 0 || r.n > 1)
      // Generic words survive that gate ("Time", "New", "People"), so drop them.
      .filter((r) => r.words > 1 || !TOPIC_STOP.has(r.label.toLowerCase()))
      // Corroboration first, then specificity. Mid-sentence is a gate, not a rank.
      .sort((a, b) =>
        (b.n - a.n) ||
        (b.words - a.words) ||
        (b.label.length - a.label.length));
    if (!ranked.length) return "";
    // Once a cluster is big enough to corroborate, insist that it does.
    if (items.length > 2 && ranked[0].n < 2) return "";
    return ranked[0].label;
  }

  /* The headline closest to what the cluster collectively says, rather than
     whichever outlet happened to file most recently. */
  function centralItem(items) {
    if (items.length === 1) return items[0];
    const sigs = items.map((i) => new Set(tokens(i.title)));
    let best = items[0];
    let bestScore = -1;
    items.forEach((item, idx) => {
      let overlap = 0;
      sigs.forEach((other, j) => { if (j !== idx) overlap += jaccard(sigs[idx], other); });
      const mean = overlap / Math.max(1, items.length - 1);
      // Nudge toward primary sources and away from very short/long headlines.
      const tierBonus = item.tier === 1 ? 0.06 : 0;
      const lenPenalty = item.title.length > 110 || item.title.length < 24 ? 0.05 : 0;
      const score = mean + tierBonus - lenPenalty;
      if (score > bestScore) { bestScore = score; best = item; }
    });
    return best;
  }

  function jaccard(aSet, bSet) {
    if (!aSet.size || !bSet.size) return 0;
    let inter = 0;
    for (const x of aSet) if (bSet.has(x)) inter++;
    return inter / (aSet.size + bSet.size - inter);
  }

  /* A date written into the headline, e.g. "Daily progress for Tuesday, 12 May
     2026". Recurring bulletins share a title template and differ only here. */
  const TITLE_DATE_RE = /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+20\d\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d\d)\b/i;

  function titleDate(title) {
    const m = TITLE_DATE_RE.exec(title || "");
    return m ? m[1].toLowerCase().replace(/,/g, "").replace(/\s+/g, " ") : "";
  }

  function itemSig(item) {
    const t = item.title + " " + (item.summary || "").slice(0, 200);
    return {
      tokens: new Set(tokens(t)),
      titleTokens: new Set(tokens(item.title)),
      ents: entities(item.title),
      published: item.published,
      tier: item.tier,
      sourceId: item.sourceId,
      date: titleDate(item.title),
    };
  }

  function shared(aSet, bSet) {
    let n = 0;
    for (const x of aSet) if (bSet.has(x)) n++;
    return n;
  }

  /* Corpus-frequency context: rare shared vocabulary is evidence, ubiquitous
     vocabulary is not. "china" appears across hundreds of pool items and
     proves nothing; "convocation" appearing in both is a real tether. Built
     once per group() over the pool being clustered. */
  function dfContext(sigs) {
    const df = new Map();
    for (const s of sigs) for (const t of s.tokens) df.set(t, (df.get(t) || 0) + 1);
    const N = Math.max(1, sigs.length);
    // Weights memoized once per pool: similar() runs O(N²) times per group()
    // and must never recompute a logarithm it has already paid for.
    const idfMap = new Map();
    for (const [t, d] of df) idfMap.set(t, Math.log(1 + N / d));
    const ctx = {
      df,
      idfMap,
      idf: (t) => idfMap.get(t) || Math.log(1 + N),
      // "Rare" scales with the pool but stays above a big running story's own
      // size-driven frequency (a 16-item story makes its anchor word common
      // in-pool; 3% keeps that anchor rare enough to keep counting).
      rareMax: Math.max(6, Math.round(N * 0.03)),
    };
    // Each signature carries its total idf mass so the weighted union is
    // sumA + sumB - inter, and only the smaller set is ever iterated.
    for (const s of sigs) {
      let sum = 0;
      for (const t of s.tokens) sum += ctx.idf(t);
      s.idfSum = sum;
    }
    return ctx;
  }

  /* One pass over the smaller token set: weighted-Jaccard intersection mass
     plus the rare-anchor count. Generic words contribute almost nothing;
     distinctive event vocabulary decides. */
  function tokenAgreement(sigA, sigB, ctx) {
    const [small, large] = sigA.tokens.size <= sigB.tokens.size ? [sigA, sigB] : [sigB, sigA];
    let inter = 0, rare = 0;
    for (const t of small.tokens) {
      if (large.tokens.has(t)) {
        inter += ctx.idf(t);
        if ((ctx.df.get(t) || 0) <= ctx.rareMax) rare++;
      }
    }
    const union = (sigA.idfSum || 0) + (sigB.idfSum || 0) - inter;
    return { wsim: union ? inter / union : 0, rare };
  }

  /* Two items belong together only with a defensible narrative tether.

     An actor is not a story: eight unrelated opinion pieces about one
     politician share the name and nothing else, and "Trump takes ballroom to
     the Supreme Court" is not "Trump's tariffs struck down by the Supreme
     Court" just because both carry Trump + Supreme Court. So beyond
     near-duplicate headlines, every merge must show (a) a shared named
     entity, (b) idf-weighted lexical agreement — distinctive words, not
     diplomatic filler — and (c) at least one shared RARE word: the anchor a
     desk could point to when asked why these two are filed together. */
  const MAX_CLUSTER_GAP_DAYS = 4;

  function similar(sigA, sigB, ctx) {
    // Recurring bulletins ("Daily progress for <date>") share a title template
    // but are separate records, not one running story.
    if (sigA.date && sigB.date && sigA.date !== sigB.date) return false;
    const sameSourceApart = sigA.sourceId === sigB.sourceId &&
      Math.abs(sigA.published - sigB.published) > 20 * 3600 * 1000;

    // Same event reported twice: headlines are near-duplicates.
    const titleSim = jaccard(sigA.titleTokens, sigB.titleTokens);
    if (titleSim >= 0.5) return !(sameSourceApart && titleSim >= 0.7);

    const sharedEnts = shared(sigA.ents, sigB.ents);
    const { wsim, rare } = tokenAgreement(sigA, sigB, ctx);
    if (!sharedEnts) {
      // No named tether at all: only near-identical copy may pass.
      return wsim >= 0.5 && rare >= 2;
    }

    let multiEnt = false;
    for (const e of sigA.ents) if (e.indexOf(" ") > 0 && sigB.ents.has(e)) { multiEnt = true; break; }

    // Strong named evidence (a full name or two entities) still needs real
    // weighted agreement — entity count alone can no longer merge.
    if (sharedEnts >= 2 || multiEnt) return wsim >= 0.22 && rare >= 1;
    // One single-word entity (a country, a surname) is the weakest tether.
    return wsim >= 0.30 && rare >= 2;
  }

  /* News clusters are time-bounded: the same running story files repeatedly
     over days, not weeks. Primary documents get more latitude. */
  function withinWindow(sig, cluster) {
    const gapDays = Math.abs(sig.published - cluster.centre) / 86400000;
    const limit = sig.tier === 1 ? MAX_CLUSTER_GAP_DAYS * 2.5 : MAX_CLUSTER_GAP_DAYS;
    return gapDays <= limit;
  }

  /* One ranking for the whole room. The front page and the local brief must
     agree on what leads; two hand-tuned copies of this formula drifted apart
     once already (ui.js used /4 and a -5 tail, local.js /3 and -3).

     The lens ("deskMode") is data, not a fork: Math.max over boosts so a
     story tagged four topics can't outrank on tag count alone. Tier-1
     presence beats wire copy at equal significance — for a spokesperson the
     release itself matters more than the write-up. principal-mentions is
     boosted in every lens: she never misses her own name. */
  const DESK_BOOSTS = {
    balanced: { "principal-mentions": 3, "nz-govt-moves": 2, "pacific-region": 1, "intelligence": 1 },
    pacific:  { "principal-mentions": 3, "pacific-region": 3, "climate-pacific": 2, "china-indopacific": 1 },
    security: { "principal-mentions": 3, "intelligence": 3, "aukus-defence": 2, "nz-govt-moves": 1 },
    nz:       { "principal-mentions": 3, "nz-govt-moves": 3, "trade-economy": 1, "intelligence": 1 },
  };

  function storyScore(story, now, deskMode) {
    const at = story.lastMoved || story.updatedAt || 0;
    const ageH = ((now || Date.now()) - at) / 3600000;
    const recency = ageH < 3 ? 4 : ageH < 12 ? 3 : ageH < 24 ? 2 : ageH < 48 ? 0 : ageH < 96 ? -2 : -5;
    const boosts = DESK_BOOSTS[deskMode] || DESK_BOOSTS.balanced;
    let topicBoost = 0;
    for (const t of story.topics || []) topicBoost = Math.max(topicBoost, boosts[t] || 0);
    const primaryDoc = (story.tiers || []).indexOf(1) >= 0 ? 1.5 : 0;
    const nzDirect = story.nzInterest && story.nzInterest.level === "direct" ? 1 : 0;
    return (story.significance || 1) * 2 + recency
      + Math.min(3, (story.itemIds || []).length / 4)
      + primaryDoc + topicBoost + nzDirect;
  }

  /* keyFacts changed shape from plain strings to {fact, srcs, itemIds} when
     per-fact receipts landed. Old string facts live forever in dossier
     snapshots and exports, so every consumer reads through these. */
  function factText(f) {
    return typeof f === "string" ? f : (f && f.fact) || "";
  }
  function factSrcs(f) {
    return (f && typeof f === "object" && Array.isArray(f.srcs)) ? f.srcs : [];
  }

  const Cluster = {
    /* Group new items among themselves. Returns clusters: [{items, sig}].

       Members are compared against the existing members individually rather
       than against an accumulated union signature. The union grows more
       promiscuous with every addition, which lets A-B and B-C drag in a C that
       has nothing to do with A (single-link chaining) — the mechanism behind
       three-item clusters that share only a city name. */
    group(items) {
      const clusters = [];
      const ordered = items.slice().sort((a, b) => a.published - b.published);
      const allSigs = ordered.map(itemSig);
      const ctx = dfContext(allSigs);

      ordered.forEach((item, idx) => {
        const sig = allSigs[idx];
        let best = null;
        let bestAgreement = 0;

        for (const c of clusters) {
          if (!withinWindow(sig, c)) continue;
          const agree = c.sigs.filter((other) => similar(sig, other, ctx)).length;
          // Must cohere with a majority of the cluster, never just one member.
          const need = c.sigs.length <= 2 ? 1 : Math.ceil(c.sigs.length / 2);
          if (agree >= need && agree / c.sigs.length > bestAgreement) {
            bestAgreement = agree / c.sigs.length;
            best = c;
          }
        }

        if (best) {
          best.items.push(item);
          best.sigs.push(sig);
          best.centre = best.items.reduce((a, i) => a + i.published, 0) / best.items.length;
        } else {
          clusters.push({
            items: [item],
            sigs: [sig],
            centre: item.published,
          });
        }
      });

      /* Eviction: admission is judged against the cluster as it stood at the
         time, so early members can end up outvoted by what arrived later.
         Re-test every member of a 3+ cluster against the final membership and
         evict the weakest until everyone left coheres with the majority —
         actor-only grab bags dissolve back into singletons here. */
      const evicted = [];
      for (const c of clusters) {
        let guard = 0;
        while (c.items.length >= 3 && guard++ < 8) {
          const links = c.sigs.map((s, i) =>
            c.sigs.reduce((n, o, j) => n + (i !== j && similar(s, o, ctx) ? 1 : 0), 0));
          const need = Math.ceil((c.sigs.length - 1) / 2);
          let worst = -1, worstLinks = Infinity;
          links.forEach((n, i) => { if (n < need && n < worstLinks) { worstLinks = n; worst = i; } });
          if (worst < 0) break;
          evicted.push({ items: [c.items[worst]], sigs: [c.sigs[worst]], centre: c.items[worst].published });
          c.items.splice(worst, 1);
          c.sigs.splice(worst, 1);
        }
        c.centre = c.items.reduce((a, i) => a + i.published, 0) / c.items.length;
        // The union signature is built AFTER eviction so downstream matching
        // never inherits an evicted intruder's vocabulary.
        c.sig = { tokens: new Set(), ents: new Set() };
        for (const s of c.sigs) {
          for (const t of s.tokens) c.sig.tokens.add(t);
          for (const e of s.ents) c.sig.ents.add(e);
        }
      }
      /* Evictees regroup among themselves: two wire copies of the same
         minor story can both fall below a big cluster's majority bar, and
         they should surface as one small story, not duplicate singletons. */
      const regrouped = [];
      for (const e of evicted) {
        const sig = e.sigs[0];
        let home = null;
        for (const c of regrouped) {
          if (!withinWindow(sig, c)) continue;
          const agree = c.sigs.filter((other) => similar(sig, other, ctx)).length;
          if (agree >= (c.sigs.length <= 2 ? 1 : Math.ceil(c.sigs.length / 2))) { home = c; break; }
        }
        if (home) {
          home.items.push(e.items[0]);
          home.sigs.push(sig);
          home.centre = home.items.reduce((a, i) => a + i.published, 0) / home.items.length;
        } else {
          regrouped.push(e);
        }
      }
      for (const e of regrouped) {
        e.sig = { tokens: new Set(), ents: new Set() };
        for (const s of e.sigs) {
          for (const t of s.tokens) e.sig.tokens.add(t);
          for (const x of s.ents) e.sig.ents.add(x);
        }
        clusters.push(e);
      }
      return clusters;
    },

    /* Mean pairwise title agreement: how tethered a group actually is. */
    cohesion(items) {
      if (items.length < 2) return 1;
      const sets = items.map((i) => new Set(tokens(i.title)));
      let sum = 0;
      let pairs = 0;
      for (let a = 0; a < sets.length; a++) {
        for (let b = a + 1; b < sets.length; b++) { sum += jaccard(sets[a], sets[b]); pairs++; }
      }
      return pairs ? sum / pairs : 1;
    },

    /* Build a no-AI fallback storyline from a cluster (used when no API key). */
    fallbackStoryline(cluster) {
      const lead = centralItem(cluster.items);
      const streams = [...new Set(cluster.items.map((i) => i.stream))];
      const distinctSources = new Set(cluster.items.map((i) => i.sourceId)).size;
      const now = Date.now();
      const times = cluster.items.map((i) => i.published);
      return {
        id: mintId("s"),
        topic: topicFor(cluster.items),
        // Real news times, independent of when the sweep happened to run.
        firstFiled: Math.min(...times),
        lastMoved: Math.max(...times),
        headline: lead.title,
        // The card's kicker already names the sources; the dek is the lead's
        // own summary, dropped when it would just repeat the headline.
        dek: (() => {
          const s = (lead.summary || "").slice(0, 200).trim();
          return s && s.toLowerCase() !== (lead.title || "").trim().toLowerCase() ? s : "";
        })(),
        narrative: "",
        whatsNew: [],
        keyFacts: [],
        positions: [],
        // Cross-source pickup is the significance signal; a pile of items from
        // one feed (bill stages, daily progress) is routine, not front-page.
        // Heuristic scoring caps at 4 (BULLETIN) — FLASH is reserved for the
        // AI editorial judgment.
        significance: distinctSources > 1 ? Math.min(4, 1 + distinctSources) : (lead.tier === 1 ? 2 : 1),
        streams,
        nzInterest: { level: "none", angle: "" },
        // Union of the members' deterministic tags drives lens boosts and
        // topic filters; tiers feed the primary-doc score bump.
        topics: [...new Set(cluster.items.flatMap((i) => i.topicTags || []))],
        tiers: [...new Set(cluster.items.map((i) => i.tier || 2))],
        regions: [...new Set(cluster.items.map((i) => i.region || "global"))],
        tags: [...cluster.sig.ents].slice(0, 12),
        itemIds: cluster.items.map((i) => i.id),
        aiWritten: false,
        createdAt: now,
        updatedAt: now,
        versions: [],
      };
    },

    tokens,
    entities,
    entityList,
    topicFor,
    centralItem,
    similar,
    itemSig,
    mintId,
    storyScore,
    DESK_BOOSTS,
    factText,
    factSrcs,
  };

  window.Cluster = Cluster;
})();
