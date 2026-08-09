/* sources.js — registry loader. The single source of truth is
   data/feeds.json (+ counterparts.json): the poller reads it from disk, we
   fetch it same-origin, so Python and JS can never drift. */
(function () {
  let registry = { feeds: [], streamNotes: {}, tierNotes: {}, registryVerified: "", reviewBy: "" };
  let counterparts = { counterparts: [], ministryHandles: [] };
  let leaders = { leaders: [], scopes: {} };

  const REGIONS = [
    { key: "nz", label: "NZ" },
    { key: "official", label: "Wellington" },
    { key: "pacific", label: "Pacific" },
    { key: "global", label: "Powers" },
    { key: "analysis", label: "Analysis" },
  ];

  const Sources = {
    async load() {
      const [f, c, l] = await Promise.all([
        fetch("data/feeds.json", { cache: "no-store" }).then((r) => r.json()),
        fetch("data/counterparts.json", { cache: "no-store" }).then((r) => r.json()),
        fetch("data/leaders.json", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ leaders: [], scopes: {} })),
      ]);
      registry = f;
      counterparts = c;
      leaders = l;
      return registry;
    },

    all(settings) {
      const custom = ((settings && settings.customFeeds) || []).map((c) => ({
        ...c, tier: c.tier || 2, region: c.region || "global", stream: c.stream || "global", custom: true,
      }));
      return registry.feeds.concat(custom);
    },

    /* settings.sourceToggle = {id: true|false} overrides the registry default. */
    enabled(src, settings) {
      const t = settings && settings.sourceToggle && settings.sourceToggle[src.id];
      if (t !== undefined) return !!t;
      return !src.defaultOff;
    },

    byId(id) {
      return registry.feeds.find((f) => f.id === id) || null;
    },

    meta(src) {
      return {
        note: src.custom ? "Added by you; not registry-verified." : (src.note || ""),
        tierNote: (registry.tierNotes || {})[String(src.tier)] || "",
        streamNote: (registry.streamNotes || {})[src.stream] || "",
        verifiedAt: src.verifiedAt || (src.custom ? "" : registry.registryVerified),
      };
    },

    counterparts() { return counterparts.counterparts || []; },
    counterpart(id) { return (counterparts.counterparts || []).find((c) => c.id === id) || null; },
    ministryHandles() { return counterparts.ministryHandles || []; },
    leaders() { return leaders.leaders || []; },
    leader(id) { return (leaders.leaders || []).find((l) => l.id === id) || null; },
    scopeLabel(key) {
      const s = (leaders.scopes || {})[key];
      return s ? s.label : key;
    },

    registryVerified() { return registry.registryVerified || ""; },
    reviewBy() { return registry.reviewBy || ""; },
    reviewDue() {
      const by = registry.reviewBy || counterparts.reviewBy;
      if (!by) return false;
      return Date.now() > Date.parse(by) - 14 * 86400000; // start nagging two weeks out
    },

    REGIONS,
    regionLabel(key) {
      const r = REGIONS.find((x) => x.key === key);
      return r ? r.label : key;
    },
  };

  window.Sources = Sources;
})();
