/* local.js — everything the AI features do, done deterministically from the
   archive so InterDesk is fully usable without an API key.

   These are compilations rather than prose: they assemble, rank and lay out
   what is already known, and never assert anything the archive does not say.
   Where the AI version would interpret, the local version shows the evidence
   and leaves the judgement to the reader. */
(function () {
  function fmtDate(ts) {
    if (!ts) return "undated";
    return new Date(ts).toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short" });
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", minute: "2-digit", hour12: true }).toUpperCase();
  }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function cell(s) { return String(s == null ? "" : s).replace(/\|/g, "/"); }

  /* Storylines carry either embedded item objects, or ids (in items or
     itemIds) into the supplied pool. Resolve to real items either way. */
  function itemsOf(story, pool) {
    const own = arr(story && story.items);
    if (own.length && typeof own[0] === "object") return own.slice();
    const ids = new Set(own.length ? own : arr(story && story.itemIds));
    return arr(pool).filter((i) => ids.has(i.id));
  }
  function newestAt(its) { return its.reduce((m, i) => Math.max(m, i.published || 0), 0); }

  /* Tier-1 NZ official output: the "Government did / Government answered"
     test used by two brief sections. Items without tier metadata count, so
     archives that never set tier still populate the sections. */
  function isGovOfficial(i) {
    return i && i.stream === "nz-official" && (i.tier == null || Number(i.tier) === 1);
  }
  function isPacific(story, its) {
    if (arr(story && story.topics).includes("pacific-region")) return true;
    return its.some((i) => i.region === "pacific" || arr(i.topicTags).includes("pacific-region"));
  }
  function isGlobal(its) {
    const g = its.filter((i) => i.region === "global").length;
    return g > 0 && g >= its.length / 2;
  }

  /* Shared ranking: defer to the Cluster heuristics' score when present so
     the local brief's leads match the front page; otherwise a plain
     significance + volume + freshness formula. */
  function score(story, its, now) {
    if (window.Cluster && typeof Cluster.storyScore === "function") {
      try { return Cluster.storyScore(story, now); } catch (_) { /* fall through */ }
    }
    const ageH = (now - newestAt(its)) / 3600000;
    return (story.significance || 2) * 10 + Math.min(its.length, 6) * 2 - Math.min(Math.max(ageH, 0), 48) / 4;
  }

  /* One-line story entry with receipts: newest item's source, date, link. */
  function storyLine(story, its) {
    const top = its[0];
    let line = "- **" + (story.headline || story.topic || "untitled") + "**";
    if (story.topic && story.topic !== story.headline) line += " _(" + story.topic + ")_";
    if (top) {
      line += " — " + (top.sourceName || "unknown") + ", " + fmtDate(top.published) +
        (top.link ? " — [link](" + top.link + ")" : "");
      if (its.length > 1) line += " _+" + (its.length - 1) + " more_";
    } else {
      line += " — no items on file";
    }
    return line;
  }

  const Local = {
    /* Deterministic morning brief: same five headings as AI.streamBrief, but
       every section is a compilation with receipts, never commentary. */
    brief({ storylines = [], items = [], now = Date.now() } = {}) {
      const stories = arr(storylines).map((s) => ({
        s,
        its: itemsOf(s, items).slice().sort((a, b) => (b.published || 0) - (a.published || 0)),
      }));

      let md = "# Morning brief · " + fmtDate(now) + "\n\n";
      if (!stories.length && !arr(items).length) {
        return md + "\nNothing in the archive yet. Run a sweep, or add an API key in Settings for the written brief.\n";
      }

      // Overnight global: top-scored global-region stories under 18 hours old.
      const overnight = stories
        .filter(({ s, its }) => its.length && now - newestAt(its) < 18 * 3600000 && isGlobal(its) && !isPacific(s, its))
        .sort((a, b) => score(b.s, b.its, now) - score(a.s, a.its, now))
        .slice(0, 6);
      md += "\n## Overnight global\n";
      md += overnight.length
        ? overnight.map(({ s, its }) => storyLine(s, its)).join("\n") + "\n"
        : "\nNothing global filed in the last 18 hours.\n";

      // Pacific watch: region or topic says Pacific.
      const pacific = stories
        .filter(({ s, its }) => isPacific(s, its))
        .sort((a, b) => score(b.s, b.its, now) - score(a.s, a.its, now))
        .slice(0, 6);
      md += "\n## Pacific watch\n";
      md += pacific.length
        ? pacific.map(({ s, its }) => storyLine(s, its)).join("\n") + "\n"
        : "\nNothing from the Pacific in the archive.\n";

      // What the Government did: tier-1 official items, newest first, dated.
      const gov = arr(items).filter(isGovOfficial)
        .sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 10);
      md += "\n## What the Government did\n";
      md += gov.length
        ? gov.map((i) => "- " + fmtDate(i.published) + " · **" + (i.title || "untitled") + "** — " +
            (i.sourceName || "official") + (i.link ? " — [link](" + i.link + ")" : "")).join("\n") + "\n"
        : "\nNo tier-1 official releases in the archive.\n";

      // What to raise: covered but unanswered. Storylines with 3+ items and
      // no NZ official response attached; listed with receipts, no
      // generated commentary.
      const raise = stories
        .filter(({ its }) => its.length >= 3 && !its.some(isGovOfficial))
        .sort((a, b) => score(b.s, b.its, now) - score(a.s, a.its, now))
        .slice(0, 6);
      md += "\n## What to raise\n";
      if (raise.length) {
        md += "_Covered but unanswered: 3+ items on file, no tier-1 NZ official item attached._\n\n";
        for (const { s, its } of raise) {
          md += storyLine(s, its) + "\n" +
            "  - receipts: " + its.slice(0, 3).map((i) => (i.sourceName || "unknown") + " " + fmtDate(i.published)).join("; ") + "\n";
        }
      } else {
        md += "\nNo storyline meets the covered-but-unanswered test (3+ items, no official response).\n";
      }

      // On the radar: FADATA calendar entries inside 60 days.
      md += "\n## On the radar\n";
      const cal = (window.FADATA && FADATA.data && FADATA.data.calendar) || [];
      const upcoming = cal.filter((c) => {
        const start = Date.parse(c.startISO || "") || 0;
        const end = Date.parse(c.endISO || c.startISO || "") || start;
        return end >= now - 86400000 && start <= now + 60 * 86400000;
      });
      md += upcoming.length
        ? upcoming.map((c) => "- **" + c.startISO + (c.endISO && c.endISO !== c.startISO ? " to " + c.endISO : "") +
            ":** " + c.event + " — " + c.place + " _(reference data, verified " +
            (FADATA.data.verifiedAsOf || "") + ")_").join("\n") + "\n"
        : "\nNothing on the reference calendar inside 60 days.\n";

      return md;
    },

    /* Deterministic backgrounder: chronology, key facts if the storyline
       carries them, and the reference-glossary terms the story touches. */
    backgrounder(story, items) {
      if (!story) return "No story selected. Pick a storyline to background.";
      const its = itemsOf(story, items).slice().sort((a, b) => (a.published || 0) - (b.published || 0));

      let md = "# " + (story.headline || story.topic || "Backgrounder") + "\n\n";
      if (story.dek) md += "\n" + story.dek + "\n";

      md += "\n## Chronology\n\n";
      if (its.length) {
        md += "| Date | Source | Headline |\n|---|---|---|\n";
        for (const i of its.slice(0, 30)) {
          const head = i.link ? "[" + cell(i.title) + "](" + i.link + ")" : cell(i.title);
          md += "| " + fmtDate(i.published) + " | " + cell(i.sourceName) + " | " + head + " |\n";
        }
      } else {
        md += "No wire items attached to this story.\n";
      }

      const facts = arr(story.keyFacts);
      if (facts.length) {
        md += "\n## Key facts\n";
        md += facts.map((f) => {
          if (typeof f === "string") return "- " + f;
          const refs = arr(f.refs);
          return "- " + (f.fact || "") + (refs.length ? " _(" + refs.join(", ") + ")_" : "");
        }).join("\n") + "\n";
      }

      // Glossary: link any reference terms appearing in the story's text.
      const text = [story.topic, story.headline, story.dek, story.narrative]
        .concat(its.map((i) => (i.title || "") + " " + (i.summary || "")))
        .join(" ").toLowerCase();
      const glossary = (window.FADATA && FADATA.data && FADATA.data.glossary) || [];
      const hit = glossary.filter((g) => (g.match || [String(g.term || "").toLowerCase()]).some((k) => {
        const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp("(^|[^a-z0-9])" + esc + "($|[^a-z0-9])").test(text);
      }));
      if (hit.length) {
        md += "\n## Glossary\n";
        md += hit.map((g) => "- **" + g.term + ":** " + g.def).join("\n") + "\n";
      }
      return md;
    },

    /* Weekly activity compile for one counterpart (Portfolio space): counts
       by kind, then the items grouped by day, newest day first. */
    digest(items, counterpartId) {
      if (!counterpartId) return "No counterpart selected.";
      let md = "# Weekly activity · " + counterpartId + "\n\n";

      const pool = arr(items)
        .filter((i) => arr(i.counterparts).some((c) => c && c.id === counterpartId))
        .sort((a, b) => (b.published || 0) - (a.published || 0));
      if (!pool.length) return md + "\nNothing on file for this counterpart.\n";

      const now = Date.now();
      let list = pool.filter((i) => now - (i.published || 0) < 7 * 86400000);
      if (!list.length) {
        list = pool.slice(0, 20);
        md += "\n_Nothing in the last 7 days; showing the most recent " + list.length + " items instead._\n";
      }

      const kinds = new Map();
      for (const i of list) {
        const k = i.kind || i.stream || "item";
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
      md += "\n**Activity:** " + [...kinds.entries()].map(([k, n]) => n + " " + k).join(", ") +
        " (" + list.length + " item" + (list.length === 1 ? "" : "s") + ")\n";

      const byDay = new Map();
      for (const i of list) {
        const d = fmtDate(i.published);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(i);
      }
      for (const [day, dayItems] of byDay) {
        md += "\n**" + day + "**\n";
        md += dayItems.map((i) => "- " + (i.title || "untitled") + " — " + (i.sourceName || "unknown") +
          (i.kind ? " _(" + i.kind + ")_" : "") + (i.link ? " — [link](" + i.link + ")" : "")).join("\n") + "\n";
      }
      return md;
    },
  };

  window.Local = Local;
})();
