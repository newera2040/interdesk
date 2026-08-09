/* app.js — boot, state, actions, the 20-minute corpus loop, relay sync.
   Always the last script; everything else must already be on window. */
(function () {
  const DEFAULT_SETTINGS = {
    theme: "",
    fontScale: 1,
    lens: "balanced",
    refreshMins: 20,
    sourceToggle: {},
    counterpartsOn: {},
    customFeeds: [],
    muted: { topics: [], sources: [] },
    clockZones: ["canberra", "washington", "london"],
    apiKey: "",
    model: "claude-opus-5",
    synthModel: "claude-opus-5",
    relayUrl: "",
    relayKey: "",
    deskKey: "",
  };

  const App = {
    state: {
      items: [],
      stories: null,        // cache: {list, muted, lens, rev}
      settings: { ...DEFAULT_SETTINGS },
      readState: {},
      saved: [],
      highlights: [],
      pins: [], notes: {}, responds: [], deskMeta: null, deskPage: null,
      newPinIds: [],
      deskMode: false,
      sweeping: false,
      relaySyncedAt: 0,
      catchup: null,
      rev: 0,               // bumped when items change; invalidates story cache
      uiState: { hlArmed: false, savedTab: "saved", cpCoverage: false, brief: null, searchOpen: false, packReview: "", deskDraft: null },
    },

    /* ============ boot ============ */
    async boot() {
      try {
        await Promise.all([Sources.load(), Fatopics.load()]);
      } catch (e) {
        UI.toast("Could not load the registry: " + e.message, 8000);
      }
      App.state.settings = { ...DEFAULT_SETTINGS, ...(await Store.kvGet("settings", {})) };
      // Session-only desk key: purge any copy an older build persisted, so
      // desk mode always starts locked and the key is re-entered every open.
      if (App.state.settings.deskKey) {
        App.state.settings.deskKey = "";
        await Store.kvSet("settings", { ...App.state.settings, deskKey: "" });
      }
      App.state.readState = await Store.kvGet("readState", {});
      App.applyTheme();
      App.applyFont();
      App.state.saved = await Store.getAll("saved");
      App.state.highlights = await Store.getAll("highlights");
      App.setItems((await Store.getAll("items")).sort((a, b) => b.published - a.published));
      await Corpus.restoreMeta();
      Relay.configure({ url: App.state.settings.relayUrl, readKey: App.state.settings.relayKey, deskKey: App.state.settings.deskKey });
      App.state.deskMode = !!(App.state.settings.deskKey && App.state.settings.relayUrl);
      if (window.Clock) Clock.init({ getSettings: () => App.state.settings });

      // Catch-up eligibility decided ONCE at boot so the strip can't appear
      // mid-session (newsroom doctrine).
      const lastVisit = await Store.kvGet("lastVisit", 0);
      if (lastVisit && Date.now() - lastVisit > 30 * 60000) {
        const count = App.state.items.filter((i) => i.published > lastVisit && !App.readStateFor(i.id).readAt && !App.isMuted(i) && App.inScope(i)).length;
        const pacific = App.state.items.filter((i) => i.published > lastVisit && i.region === "pacific" && !App.readStateFor(i.id).readAt).length;
        const words = count * 40;
        App.state.catchup = {
          eligible: count > 3, since: lastVisit,
          sinceLabel: UI.dayLabel(lastVisit).replace(/^(\w+).*/, "$1") + " " + UI.timeShort(lastVisit),
          count, pacific, mins: Math.max(1, Math.round(words / 220)),
        };
      }

      App.wire();
      UI.render();
      App.startLoop();
      App.syncRelay(true);
      App.registerSW();
      Store.kvSet("lastVisit", Date.now());
      // Direct loads land without a hashchange; the routes with entry work
      // still need it.
      if ((location.hash || "").indexOf("#/deskroom") === 0 && App.state.deskMode) App.deskDraftInit(false);
      if ((location.hash || "").indexOf("#/desk") === 0 && (location.hash || "").indexOf("#/deskroom") !== 0) App.acknowledgeDesk();
    },

    /* ============ the 20-minute loop ============ */
    _timer: null,
    startLoop() {
      const due = async () => {
        const last = await Store.kvGet("lastSweep", 0);
        return Date.now() - last >= App.state.settings.refreshMins * 60000;
      };
      const tick = async () => {
        if (await due()) await App.sweep(false);
        App.scheduleNext();
      };
      tick();
      document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState === "visible") {
          // iOS freezes timers while a Home Screen app is suspended; a session
          // resumed later must catch up now, not in 20 minutes.
          if (await due()) await App.sweep(false);
          App.syncRelay(true);
          App.scheduleNext();
        } else {
          Store.kvSet("lastVisit", Date.now());
        }
      });
    },
    async scheduleNext() {
      clearTimeout(App._timer);
      // Remaining time, not a full interval: booting 18 minutes after the
      // last sweep schedules the next in 2 minutes, so an always-open tab
      // stays on cadence instead of drifting a whole interval behind.
      const last = await Store.kvGet("lastSweep", 0);
      const delay = Math.max(5000, App.state.settings.refreshMins * 60000 - (Date.now() - last));
      App._timer = setTimeout(async () => {
        await App.sweep(false);
        App.scheduleNext();
      }, delay);
    },

    /* The button-triggered sweep: same work as App.sweep, narrated stage by
       stage. Each stage holds the floor for a beat (MIN_MS) so the reader can
       see what happened, but the work itself never waits on the theatre —
       only the reveal does. */
    async stagedSweep() {
      if (App.state.sweeping) return;
      const MIN_MS = 380;
      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const STAGES = ["Checking for updates", "Reading the news update", "Polling feeds directly", "Merging new items", "Grouping storylines", "Syncing the desk"];
      App.state.sweeping = true;
      document.body.classList.add("sweeping");
      UI.renderChrome(location.hash.split("?")[0] || "#/");
      UI.sweepPanel(STAGES);
      const t0 = [];
      const start = (i) => { t0[i] = Date.now(); UI.sweepStage(i, "active"); };
      const settle = async (i, status, detail) => {
        await delay(Math.max(0, MIN_MS - (Date.now() - t0[i])));
        UI.sweepStage(i, status, detail);
      };
      try {
        let bake = null;
        let added = 0;
        let bakeOk = true;
        start(0);
        try {
          const res = await Corpus.sweep(async (stage, info) => {
            if (stage === "bake") { bake = info; }
          });
          added += res.added;
          await settle(0, "done", "connected");
          start(1);
          const f = Corpus.freshness();
          const failed = res.failed || [];
          await settle(1, "done",
            `compiled ${f.bakeAgeMin < 1 ? "just now" : f.bakeAgeMin < 60 ? f.bakeAgeMin + " min ago" : Math.round(f.bakeAgeMin / 60) + " h ago"} · ${(bake && bake.counts && bake.counts.ok) || "?"} sources` +
            (failed.length ? ` · ${failed.length} down` : ""));
        } catch (e) {
          bakeOk = false;
          await settle(0, "fail", e.message.slice(0, 50));
          start(1);
          await settle(1, "skip", "nothing to read");
        }
        // Stale (or missing) bake: the wire must not wait for the baker.
        start(2);
        if (!bakeOk || App.bakeIsStale()) {
          const live = await Corpus.liveBoost(App.state.settings, (done, total, got) => {
            UI.sweepStage(2, "active", `${done}/${total} feeds · +${got}`);
          });
          added += live.added;
          if (live.ok > 0) await settle(2, "done", `${live.added} new from ${live.ok} of ${live.polled} feeds`);
          else await settle(2, "fail", "feeds unreachable");
        } else {
          await settle(2, "skip", "already up to date");
        }
        start(3);
        if (added) {
          App.setItems((await Store.getAll("items")).sort((a, b) => b.published - a.published));
          App.state.rev++;
          App.state.stories = null;
        }
        await settle(3, "done", `${added} new · ${App.state.items.length} held`);
        start(4);
        const stories = App.buildStories();
        await settle(4, "done", `${stories.list.length} storylines`);
        start(5);
        if (Relay.enabled()) {
          // syncRelay swallows its own errors (background politeness); the
          // panel must not report "done" on a dead relay, so check the stamp.
          const before = App.state.relaySyncedAt;
          await App.syncRelay(true);
          if (App.state.relaySyncedAt > before) {
            const open = App.state.responds.filter((r) => r.status === "open").length;
            await settle(5, "done", `${App.state.pins.length} pin${App.state.pins.length === 1 ? "" : "s"} · ${open} open flag${open === 1 ? "" : "s"}`);
          } else {
            await settle(5, "fail", "relay unreachable");
          }
        } else {
          await settle(5, "skip", "relay not configured");
        }
        await Store.kvSet("lastSweep", Date.now());
        UI.render();
        UI.sweepFinish(added
          ? `${added} new · current as of ${UI.timeShort(Date.now())}`
          : `Nothing new · current as of ${UI.timeShort(Date.now())}`);
      } catch (e) {
        for (let i = 0; i < STAGES.length; i++) {
          const row = document.querySelector(`.sw-stage[data-i="${i}"].active`);
          if (row) UI.sweepStage(i, "fail", e.message.slice(0, 60));
        }
        UI.sweepFinish("Update failed: " + e.message.slice(0, 80), true);
      } finally {
        App.state.sweeping = false;
        document.body.classList.remove("sweeping");
        UI.renderChrome(location.hash.split("?")[0] || "#/");
      }
    },

    /* A stale bake must not mean a stale wire: if the corpus is older than
       twice the refresh interval (baker asleep, cron slipped, local dev),
       top up from the feeds directly — rate-limited by lastLive so a dead
       baker doesn't turn every sweep into a 40-feed proxy run. */
    bakeIsStale() {
      const f = Corpus.freshness();
      return f.bakeAgeMin > Math.max(45, App.state.settings.refreshMins * 2);
    },
    liveTopUpDue() {
      return App.bakeIsStale() &&
        Date.now() - (Corpus.lastLive || 0) > App.state.settings.refreshMins * 60000;
    },

    async sweep(manual) {
      if (App.state.sweeping) return;
      App.state.sweeping = true;
      UI.renderChrome(location.hash.split("?")[0] || "#/");
      try {
        let added = 0;
        try {
          const res = await Corpus.sweep();
          added += res.added;
        } catch (e) {
          if (manual) UI.toast("Update failed: " + e.message, 4000);
        }
        if (App.liveTopUpDue()) {
          const live = await Corpus.liveBoost(App.state.settings);
          added += live.added;
        }
        if (added) {
          App.setItems((await Store.getAll("items")).sort((a, b) => b.published - a.published));
          App.state.rev++;
          App.state.stories = null;
        }
        if (manual) UI.toast(added ? added + " new items" : "Up to date");
        if (added || manual) UI.render();
        App.syncRelay(true);
      } catch (e) {
        if (manual) UI.toast("Refresh failed: " + e.message, 5000);
      } finally {
        // Stamp the attempt even on failure: the remaining-time scheduler
        // would otherwise see "due" forever and retry every 5 seconds.
        await Store.kvSet("lastSweep", Date.now());
        App.state.sweeping = false;
        UI.renderChrome(location.hash.split("?")[0] || "#/");
      }
    },

    registerSW() {
      if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
      navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is a bonus, not a dependency */ });
    },

    /* ============ derived data ============ */
    setItems(arr) {
      App.state.items = arr;
      App.state.itemsById = new Map(arr.map((i) => [i.id, i]));
    },
    itemById(id) { return (App.state.itemsById && App.state.itemsById.get(id)) || null; },
    savedById(id) { return App.state.saved.find((s) => s.id === id) || null; },
    pinnedItemStub(id) {
      const pin = App.state.pins.find((p) => p.itemId === id);
      if (!pin) return null;
      // Pin blobs carry snapshot fields so a pin renders even before the
      // corpus copy reaches this device.
      return { id, title: pin.title, link: pin.link, summary: pin.note || "", sourceName: pin.source || "Desk pin", region: pin.bucket || "global", published: pin.at, tier: 2, topicTags: [] };
    },

    buildStories() {
      const S = App.state;
      if (S.stories && S.stories.rev === S.rev && S.stories.lens === S.settings.lens) return S.stories;
      const windowMs = 96 * 3600000;
      const cutoff = Date.now() - windowMs;
      const recent = S.items.filter((i) => i.published > cutoff && App.inScope(i));
      const clusters = Cluster.group(recent);
      const list = [];
      const muted = [];
      for (const c of clusters) {
        const story = Cluster.fallbackStoryline(c);
        // Deterministic id from membership: the same cluster gets the same id
        // on every rebuild, so story links survive and Today doesn't reshuffle.
        story.id = "s" + UI.fnv(c.items.map((i) => i.id).sort().join("|"));
        story.lastMoved = Math.max(...c.items.map((i) => i.published));
        story.updatedAt = story.lastMoved;
        story.score = Cluster.storyScore(story, Date.now(), S.settings.lens);
        (App.storyMuted(story) ? muted : list).push(story);
      }
      list.sort((a, b) => b.score - a.score);
      S.stories = { list, muted, rev: S.rev, lens: S.settings.lens, byId: new Map(list.concat(muted).map((s) => [s.id, s])) };
      return S.stories;
    },
    rankedStories() {
      const st = App.buildStories();
      // Pinned stories always surface via the pin rail; muting never hides pins.
      return { list: st.list, muted: st.muted };
    },
    storyById(id) {
      const st = App.buildStories();
      return st.byId.get(id) || null;
    },

    storyMuted(story) {
      const m = App.state.settings.muted;
      if ((story.topics || []).some((t) => (m.topics || []).indexOf(t) >= 0)) return true;
      return false;
    },
    isMuted(item) {
      const m = App.state.settings.muted;
      if (App.state.pins.some((p) => p.itemId === item.id)) return false; // pins override mutes, always
      if ((item.topicTags || []).some((t) => (m.topics || []).indexOf(t) >= 0)) return true;
      if ((m.sources || []).indexOf(item.sourceId) >= 0) return true;
      return false;
    },

    /* Foreign-news scope: Today, Wire and Catch-up only carry foreign items
       that concern NZ and its interests (taxonomy nzScope, via Fatopics).
       Person files and search look at everything — they are explicit asks.
       Region comes from the CURRENT registry, not the stored stamp — items
       written before a feed reclassification would otherwise dodge the gate
       until they age out. */
    inScope(item) {
      if (!(window.Fatopics && Fatopics.inScope)) return true;
      const src = window.Sources && Sources.byId ? Sources.byId(item.sourceId) : null;
      const it = src && src.region && src.region !== item.region ? { ...item, region: src.region } : item;
      return Fatopics.inScope(it);
    },

    /* Every relevant media mention of a person, ranked by the relevance
       engine — independent of poller tagging scope, so a portfolio-only
       counterpart (the PM) still has a full coverage file. Tier 1+ only:
       passing mentions are noise, features/subject/authored are coverage. */
    coverageItems(person) {
      const out = [];
      for (const i of App.state.items) {
        const rel = App.relevance(i, person);
        if (rel.tier >= 1) out.push(i);
      }
      return out;
    },

    counterpartItems(cpId, rel) {
      return App.state.items.filter((i) => (i.counterparts || []).some((c) => c.id === cpId && (!rel || c.rel === rel)));
    },

    /* How much an item is actually ABOUT a person — the portfolio ranking.
       Tiers, most to least: 3 their own output; 2 they are the subject
       (name in the headline); 1 they feature (quoted, or named repeatedly);
       0 a passing mention. Computed from the text so it works identically
       for ministers and world leaders, with no re-bake needed. */
    _relCache: new Map(),
    _relFor(person) {
      let c = App._relCache.get(person.id);
      if (c) return c;
      const surname = (person.surname || person.weakSurname || "").toLowerCase();
      const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      c = {
        surname,
        names: [person.matchName, person.name].concat(person.strongNames || [])
          .filter(Boolean).map((n) => String(n).toLowerCase()),
        surnameRe: surname ? new RegExp("\\b" + escRe(surname) + "\\b") : null,
        surnameAllRe: surname ? new RegExp("\\b" + escRe(surname) + "\\b", "g") : null,
        quotedRe: surname ? new RegExp("(?:\\b" + escRe(surname) + "\\b[^.]{0,60}\\b(said|says|told|warned|announced|confirmed)\\b)|(?:\\b(said|says|told)\\b[^.]{0,40}\\b" + escRe(surname) + "\\b)") : null,
      };
      App._relCache.set(person.id, c);
      return c;
    },
    relevance(item, person) {
      const authored = (item.counterparts || []).some((c) => c.id === person.id && c.rel === "author");
      if (authored) return { tier: 3, label: "Their words" };
      const c = App._relFor(person);
      const title = (item.title || "").toLowerCase();
      const body = (item.summary || "").toLowerCase();
      const inTitle = c.names.some((n) => title.indexOf(n) >= 0) || (c.surnameRe && c.surnameRe.test(title));
      if (inTitle) return { tier: 2, label: "The subject" };
      const all = title + " " + body;
      let mentions = 0;
      if (c.surnameAllRe) mentions = (all.match(c.surnameAllRe) || []).length;
      else for (const n of c.names) mentions += all.split(n).length - 1;
      if ((c.quotedRe && c.quotedRe.test(all)) || mentions >= 2) return { tier: 1, label: "Features" };
      return { tier: 0, label: "Mentioned" };
    },

    /* Wider context for an item: cluster siblings first (same storyline),
       then same-topic items within 72h — always other outlets' takes. */
    relatedItems(item, max) {
      const out = [];
      const seen = new Set([item.id]);
      const stories = App.buildStories();
      for (const story of stories.list.concat(stories.muted)) {
        if ((story.itemIds || []).indexOf(item.id) >= 0) {
          for (const sid of story.itemIds) {
            const sib = App.itemById(sid);
            if (sib && !seen.has(sib.id)) { seen.add(sib.id); out.push(sib); }
          }
          break;
        }
      }
      if (out.length < max) {
        const topics = item.topicTags || [];
        const cutoff = item.published - 72 * 3600000;
        for (const cand of App.state.items) {
          if (out.length >= max) break;
          if (seen.has(cand.id) || cand.published < cutoff) continue;
          if (topics.length && (cand.topicTags || []).some((t) => topics.indexOf(t) >= 0)
              && (cand.via || cand.sourceName) !== (item.via || item.sourceName)) {
            seen.add(cand.id);
            out.push(cand);
          }
        }
      }
      return out.slice(0, max);
    },
    counterpartDaily(cpId) {
      const ts = App.counterpartItems(cpId, "author").map((i) => i.published);
      return Charts.dayBuckets(ts, { days: 7 });
    },

    leaderItems(ldId, scope) {
      return App.state.items.filter((i) => (i.leaders || []).indexOf(ldId) >= 0 && (!scope || i.scope === scope));
    },
    leaderDaily(ldId) {
      return Charts.dayBuckets(App.leaderItems(ldId).map((i) => i.published), { days: 7 });
    },
    leaderScopeCounts(ldId) {
      const counts = { globe: 0, country: 0, self: 0 };
      for (const i of App.leaderItems(ldId)) counts[i.scope] = (counts[i.scope] || 0) + 1;
      return counts;
    },

    sortedPins() {
      const order = { lead: 0, priority: 1, fyi: 2 };
      return App.state.pins.slice().sort((a, b) => (order[a.priority] ?? 3) - (order[b.priority] ?? 3) || b.at - a.at);
    },
    respondFor(id) { return App.state.responds.find((r) => r.itemId === id) || null; },

    /* ============ read state ============ */
    readStateFor(id) { return App.state.readState[id] || {}; },
    _persistRead: null,
    markSeen(id) {
      const rs = App.state.readState;
      if (rs[id] && rs[id].seenAt) return;
      rs[id] = { ...(rs[id] || {}), seenAt: Date.now() };
      App.persistReadSoon();
    },
    markRead(id, on) {
      const rs = App.state.readState;
      rs[id] = { ...(rs[id] || {}), seenAt: (rs[id] && rs[id].seenAt) || Date.now(), readAt: on === false ? 0 : Date.now() };
      App.persistReadSoon();
    },
    persistReadSoon() {
      clearTimeout(App._persistRead);
      App._persistRead = setTimeout(() => Store.kvSet("readState", App.state.readState), 400);
    },

    _observer: null,
    observeSeen(main) {
      if (App._observer) App._observer.disconnect();
      if (App._seenTimers) { for (const t of Object.values(App._seenTimers)) clearTimeout(t); }
      App._seenTimers = {};
      App._observer = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (en.intersectionRatio >= 0.6) {
            const id = en.target.dataset.item;
            App._seenTimers = App._seenTimers || {};
            if (!App._seenTimers[id]) {
              App._seenTimers[id] = setTimeout(() => { App.markSeen(id); en.target.classList.remove("unread"); }, 1000);
            }
          } else {
            const id = en.target.dataset.item;
            if (App._seenTimers && App._seenTimers[id]) { clearTimeout(App._seenTimers[id]); delete App._seenTimers[id]; }
          }
        }
      }, { threshold: [0.6] });
      for (const row of main.querySelectorAll(".wire-row[data-item]")) App._observer.observe(row);
    },

    /* ============ saves + highlights ============ */
    isSaved(id) { return App.state.saved.some((s) => s.id === id); },
    async toggleSave(id) {
      if (App.isSaved(id)) return App.unsave(id);
      const item = App.itemById(id) || App.pinnedItemStub(id);
      const story = App.storyById(id);
      let snap;
      if (item) {
        snap = { id, title: item.title, link: item.link, sourceName: item.sourceName, summary: item.summary, region: item.region, published: item.published, savedAt: Date.now() };
      } else if (story) {
        snap = { id, title: story.headline, link: "", sourceName: story.topic, summary: story.dek, region: (story.regions || [])[0], published: story.updatedAt, savedAt: Date.now() };
      } else return;
      await Store.put("saved", snap);
      App.state.saved.push(snap);
      UI.toast("Saved");
      UI.render();
    },
    async unsave(id) {
      await Store.delete("saved", id);
      App.state.saved = App.state.saved.filter((s) => s.id !== id);
      UI.render();
    },

    highlightHashesFor(refId) {
      return new Set(App.state.highlights.filter((h) => h.refId === refId).map((h) => h.sentHash));
    },
    orphanHighlightsFor(refId) {
      // A rewrite that dropped a marked sentence orphans it gracefully — it
      // still shows, labelled, and stays in Saved and exports.
      const current = new Set();
      const story = refId.startsWith("s:") ? App.storyById(refId.slice(2)) : null;
      const item = story ? null : App.itemById(refId);
      const text = story ? (story.narrative || story.dek || "") : item ? (item.summary || "") : "";
      for (const s of UI.splitSentences(text)) current.add(UI.sentHash(s));
      return App.state.highlights.filter((h) => h.refId === refId && !current.has(h.sentHash));
    },
    async toggleHighlight(refId, sh, sentIdx, text) {
      const existing = App.state.highlights.find((h) => h.refId === refId && h.sentHash === sh);
      if (existing) {
        await Store.delete("highlights", existing.id);
        App.state.highlights = App.state.highlights.filter((h) => h.id !== existing.id);
        return false;
      }
      const src = refId.startsWith("s:") ? App.storyById(refId.slice(2)) : App.itemById(refId);
      const hl = {
        id: "h" + UI.fnv(refId + "|" + sh),
        scope: refId.startsWith("s:") ? "story" : "item",
        refId, sentHash: sh, sentIdx, text,
        context: src ? { title: src.headline || src.title, link: src.link || "", source: src.sourceName || src.topic || "", published: src.published || src.updatedAt } : {},
        at: Date.now(),
      };
      await Store.put("highlights", hl);
      App.state.highlights.push(hl);
      return true;
    },
    async deleteHighlight(id) {
      await Store.delete("highlights", id);
      App.state.highlights = App.state.highlights.filter((h) => h.id !== id);
      UI.render();
    },

    /* ============ share pack ============ */
    async sharePack() {
      const since = Date.now() - 7 * 86400000;
      const hls = App.state.highlights.filter((h) => h.at > since);
      const saved = App.state.saved.filter((s) => s.savedAt > since);
      if (!hls.length && !saved.length) return UI.toast("Nothing from the last 7 days to share");
      const pack = { schema: 1, app: "interdesk-pack", exportedAt: new Date().toISOString(), highlights: hls, saved };
      const byStory = {};
      for (const h of hls) (byStory[(h.context && h.context.title) || "Notes"] = byStory[(h.context && h.context.title) || "Notes"] || []).push(h);
      const mdSafe = (t) => String(t || "").replace(/[\[\]()]/g, "");
      let mdOut = "# Reading pack — " + new Date().toLocaleDateString("en-NZ") + "\n";
      for (const [title, rows] of Object.entries(byStory)) {
        const link = rows[0].context && rows[0].context.link;
        const ok = /^https?:\/\//i.test(link || "");
        mdOut += "\n## " + (ok ? "[" + mdSafe(title) + "](" + link + ")" : mdSafe(title)) + "\n";
        for (const h of rows) mdOut += "> " + h.text + "\n\n";
      }
      if (saved.length) {
        mdOut += "\n## Saved\n";
        for (const s of saved) mdOut += "- " + (/^https?:\/\//i.test(s.link || "") ? "[" + mdSafe(s.title) + "](" + s.link + ")" : mdSafe(s.title)) + " — " + (s.sourceName || "") + "\n";
      }
      const fname = "interdesk-pack-" + new Date().toISOString().slice(0, 10) + ".json";
      const file = new File([JSON.stringify(pack, null, 1)], fname, { type: "application/json" });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: "InterDesk reading pack" });
          return;
        } catch (e) { if (e.name === "AbortError") return; }
      }
      // Fallbacks: download the JSON, copy the markdown.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(file);
      a.download = fname;
      a.click();
      try { await navigator.clipboard.writeText(mdOut); UI.toast("Pack downloaded; markdown copied"); }
      catch (_) { UI.toast("Pack downloaded"); }
    },

    importPack() {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = async () => {
        try {
          const data = JSON.parse(await input.files[0].text());
          if (data.app !== "interdesk-pack") throw new Error("Not a reading pack");
          const hls = Array.isArray(data.highlights) ? data.highlights : [];
          const saved = Array.isArray(data.saved) ? data.saved : [];
          const rows = hls.map((h) =>
            `<div class="card" ${h.refId && !h.refId.startsWith("s:") ? `data-action="open-item" data-id="${UI.esc(h.refId)}"` : ""}>
              <div class="kicker">${UI.esc((h.context && h.context.source) || "")}</div>
              <p class="dek">“${UI.esc(h.text || "")}”</p>
              <div class="foot">${UI.esc((h.context && h.context.title) || "")}</div></div>`).join("");
          App.state.uiState.packReview =
            `<div class="brief-meta">V highlighted ${hls.length} line${hls.length === 1 ? "" : "s"} and saved ${saved.length} item${saved.length === 1 ? "" : "s"}.</div>` + rows;
          UI.render();
        } catch (e) { UI.toast("Import failed: " + e.message, 5000); }
      };
      input.click();
    },

    /* ============ relay sync ============ */
    async syncRelay(silent) {
      if (!Relay.enabled()) return;
      try {
        const st = await Relay.state();
        App.state.pins = st.pins || [];
        App.state.notes = {};
        for (const n of st.notes || []) App.state.notes[n.itemId] = n;
        App.state.responds = st.responds || [];
        App.state.deskMeta = st.meta || null;
        App.state.deskPage = st.desk || null;
        const seenDesk = await Store.kvGet("seenDeskShippedAt", 0);
        App.state.deskUnseenFlag = !!(App.state.deskPage && (App.state.deskPage.shippedAt || 0) > seenDesk);
        if (App.state.deskUnseenFlag && (location.hash || "").indexOf("#/desk") === 0
            && (location.hash || "").indexOf("#/deskroom") !== 0) App.acknowledgeDesk();
        App.state.relaySyncedAt = Date.now();
        const seen = new Set(await Store.kvGet("seenPins", []));
        App.state.newPinIds = App.state.pins.map((p) => p.itemId).filter((id) => !seen.has(id));
        if (App.state.newPinIds.length && !silent) UI.toast(App.state.newPinIds.length + " new from the desk");
        // A no-change relay poll must not rebuild the page under the reader.
        const sig = JSON.stringify([st.pins, st.notes, st.responds, st.meta, st.desk, App.state.newPinIds]);
        if (sig !== App._relaySig) { App._relaySig = sig; UI.render(); }
        else UI.renderChrome(location.hash.split("?")[0] || "#/");
      } catch (e) {
        if (!silent) UI.toast("Relay: " + e.message, 4000);
      }
    },
    async acknowledgePins() {
      const ids = App.state.pins.map((p) => p.itemId);
      await Store.kvSet("seenPins", ids);
      App.state.newPinIds = [];
    },

    /* ============ settings ============ */
    async saveSettings(patch) {
      App.state.settings = { ...App.state.settings, ...patch };
      // The desk key lives in memory for this session ONLY — it is never
      // written to storage, so every device starts as a reader and the key
      // must be re-entered each time the app opens.
      await Store.kvSet("settings", { ...App.state.settings, deskKey: "" });
      Relay.configure({ url: App.state.settings.relayUrl, readKey: App.state.settings.relayKey, deskKey: App.state.settings.deskKey });
    },
    applyTheme() {
      const t = App.state.settings.theme;
      if (t) document.documentElement.dataset.theme = t;
      else delete document.documentElement.dataset.theme;
      try { t ? localStorage.setItem("interdesk.theme", t) : localStorage.removeItem("interdesk.theme"); } catch (_) { /* private mode */ }
    },
    applyFont() {
      document.documentElement.style.setProperty("--reader-scale", App.state.settings.fontScale || 1);
    },

    /* ============ the Desk (shipped daily page) ============ */
    todayNZ() {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(new Date());
    },
    todayNZLong() {
      return new Intl.DateTimeFormat("en-NZ", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Pacific/Auckland" }).format(new Date());
    },

    async pastDesks(n) {
      const briefs = await Store.getAll("briefs");
      return briefs.filter((b) => b.kind === "desk")
        .sort((a, b) => (b.shippedAt || 0) - (a.shippedAt || 0))
        .slice(0, n || 3)
        .map((b) => ({ date: b.date, text: (b.html || b.md || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2500) }));
    },

    /* Load (or start) today's draft. A new day auto-runs the AI pass when a
       key is present; otherwise the local compile seeds the draft. Edits
       persist locally so a reload never loses work. */
    _briefToDeskHtml(mdText) {
      const cleaned = String(mdText || "")
        .replace(/^_?Compiled locally[^\n]*_?\n?/m, "")
        .trim();
      return UI.md(cleaned);
    },

    async deskHistoryLoad() {
      const briefs = await Store.getAll("briefs");
      App.state.uiState.deskHistory = briefs.filter((b) => b.kind === "desk")
        .sort((a, b) => (b.shippedAt || 0) - (a.shippedAt || 0)).slice(0, 14);
    },

    async deskDraftInit(force) {
      if (App._deskInitBusy) return App.state.uiState.deskDraft;
      App._deskInitBusy = true;
      try {
      await App.deskHistoryLoad();
      const S = App.state;
      const today = App.todayNZ();
      let draft = S.uiState.deskDraft;
      if (!draft) {
        draft = await Store.kvGet("deskDraft", null);
        // Legacy markdown drafts become page HTML once.
        if (draft && draft.md && !draft.html) { draft.html = UI.md(draft.md); delete draft.md; }
        S.uiState.deskDraft = draft;
      }
      if (draft && draft.date === today && !force) { UI.render(); return draft; }

      // Day rollover must not destroy hand-edited, unshipped work: carry it
      // into today (dated fresh) instead of silently regenerating over it.
      if (!force && draft && draft.date !== today && draft.source === "edited" && (draft.html || "").trim()
          && !(S.deskPage && S.deskPage.date === draft.date && S.deskPage.html === draft.html)) {
        draft = { date: today, html: draft.html, running: false, source: "edited", editedAt: Date.now() };
        S.uiState.deskDraft = draft;
        await App.deskDraftSave();
        UI.toast("Carried over the unshipped draft");
        UI.render();
        return draft;
      }

      draft = { date: today, html: "", running: false, source: "", editedAt: 0 };
      S.uiState.deskDraft = draft;
      if (S.settings.apiKey) {
        draft.running = true;
        UI.render();
        const stories = App.buildStories().list.slice(0, 20);
        const payload = {
          dateNZ: App.todayNZLong(),
          material: {
            storylines: stories.map((s) => ({
              topic: s.topic, headline: s.headline, dek: s.dek, significance: s.significance, topics: s.topics,
              items: s.itemIds.slice(0, 4).map((id) => { const i = App.itemById(id); return i ? { source: i.via || i.sourceName, title: i.title, published: new Date(i.published).toISOString() } : null; }).filter(Boolean),
            })),
            pins: App.sortedPins().map((p) => ({ title: p.title, priority: p.priority, note: p.note })),
            openFlags: S.responds.filter((r) => r.status === "open").map((r) => r.title),
          },
          pastDesks: await App.pastDesks(3),
        };
        try {
          await AI.streamDeskDraft(payload, S.settings, (text) => {
            draft.html = UI.md(text);
            const el = document.getElementById("desk-md");
            if (el) el.innerHTML = draft.html;
          }, null);
          draft.source = "ai";
        } catch (e) {
          draft.html = App._briefToDeskHtml(Local.brief({ storylines: stories, items: S.items, now: Date.now() }));
          draft.source = "draft";
          UI.toast("Auto-draft unavailable — seeded from the wire: " + e.message, 5000);
        }
        draft.running = false;
      } else {
        const stories = App.buildStories().list.slice(0, 20);
        draft.html = App._briefToDeskHtml(Local.brief({ storylines: stories, items: S.items, now: Date.now() }));
        draft.source = "draft";
      }
      await App.deskDraftSave();
      UI.render();
      return draft;
      } finally { App._deskInitBusy = false; }
    },

    deskInsert(html) {
      const d = App.state.uiState.deskDraft;
      if (!d) return;
      const el = document.getElementById("desk-md");
      if (el) {
        el.focus();
        const sel = getSelection();
        if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
          // caret outside the page: append at the end
          const r = document.createRange();
          r.selectNodeContents(el);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        document.execCommand("insertHTML", false, html);
        d.html = el.innerHTML;
      } else {
        d.html = (d.html || "") + html;
      }
      d.source = "edited";
      App.deskDraftSave();
    },

    async deskDraftSave() {
      const d = App.state.uiState.deskDraft;
      if (d) await Store.kvSet("deskDraft", { date: d.date, html: d.html, source: d.source, editedAt: Date.now() });
    },

    async deskShip() {
      const d = App.state.uiState.deskDraft;
      const el = document.getElementById("desk-md");
      if (el) d.html = el.innerHTML;
      const clean = UI.sanitizeHtml(d ? d.html : "");
      const hasText = clean.replace(/<[^>]+>/g, "").trim().length > 0;
      if (!d || !hasText) return UI.toast("Nothing to ship yet");
      if (clean.length > 30000) return UI.toast("The page is too long to ship — trim it under ~30k characters", 5000);
      const page = {
        html: clean,
        title: "The Desk",
        date: d.date,
        dateLong: App.todayNZLong(),
        shippedAt: Date.now(),
      };
      try {
        await Relay.putDesk(page);
        // Our copy: shipped desks archive locally on the desk device — the
        // AI reads them for continuity; Vanushi only ever sees the current one.
        await Store.put("briefs", { id: "desk-" + d.date + "-" + page.shippedAt, kind: "desk", ...page });
        App.state.deskPage = page;
        UI.toast("Shipped — the Desk is live for " + App.todayNZLong());
        UI.render();
      } catch (e) {
        UI.toast("Ship failed: " + e.message, 6000);
      }
    },

    async acknowledgeDesk() {
      const p = App.state.deskPage;
      App.state.deskUnseenFlag = false;
      if (p) await Store.kvSet("seenDeskShippedAt", p.shippedAt || 0);
    },
    async deskUnseen() {
      const p = App.state.deskPage;
      if (!p) return false;
      const seen = await Store.kvGet("seenDeskShippedAt", 0);
      return (p.shippedAt || 0) > seen;
    },

    /* ============ brief ============ */
    async runBrief() {
      const S = App.state;
      const stories = App.buildStories().list.slice(0, 30);
      const b = S.uiState.brief = { running: false, local: "", ai: "", error: "" };
      try {
        b.local = Local.brief({ storylines: stories, items: S.items, now: Date.now() });
      } catch (e) { b.local = "Local compile failed: " + e.message; }
      UI.render();
      if (!S.settings.apiKey) return;
      b.running = true;
      UI.render();
      const payload = {
        dateNZ: new Date().toLocaleString("en-NZ", { timeZone: "Pacific/Auckland" }),
        storylines: stories.map((s) => ({
          topic: s.topic, headline: s.headline, dek: s.dek, significance: s.significance,
          topics: s.topics, regions: s.regions,
          items: s.itemIds.slice(0, 6).map((id) => { const i = App.itemById(id); return i ? { source: i.sourceName, tier: i.tier, title: i.title, published: new Date(i.published).toISOString(), summary: (i.summary || "").slice(0, 220) } : null; }).filter(Boolean),
        })),
        pins: App.sortedPins().map((p) => ({ title: p.title, priority: p.priority, note: p.note })),
      };
      try {
        await AI.streamBrief(payload, S.settings, (textSoFar) => {
          b.ai = textSoFar;
          // Update only the brief pane per delta; a full re-render per SSE
          // frame would fight scrolling.
          const el = document.getElementById("brief-ai");
          if (el) el.innerHTML = UI.md(textSoFar) + '<span class="stream-cursor"></span>';
        }, null);
        b.running = false;
        const briefRow = { id: Cluster.mintId("b"), at: Date.now(), model: S.settings.model, md: b.ai };
        Store.put("briefs", briefRow);
      } catch (e) {
        b.error = e.message;
        b.running = false;
      }
      UI.render();
    },

    async explain(refId, scope) {
      const pane = document.getElementById("explain-pane");
      if (!pane) return;
      const story = scope === "story" ? App.storyById(refId) : null;
      const item = scope === "item" ? App.itemById(refId) : null;
      if (!story && !item) { pane.innerHTML = '<p class="quiet">This item is no longer in the archive.</p>'; return; }
      const items = story ? story.itemIds.map((id) => App.itemById(id)).filter(Boolean) : item ? [item] : [];
      let localMd = "";
      try { localMd = Local.backgrounder(story || { headline: item && item.title, topic: "" }, items); } catch (e) { localMd = ""; }
      pane.innerHTML = '<div class="section-head"><span class="local-badge">LOCAL</span> Background</div><div class="md">' + UI.md(localMd) + "</div>";
      if (!App.state.settings.apiKey) return;
      pane.innerHTML += '<div class="section-head"><span class="ai-badge">AI</span> Backgrounder</div><div class="md" id="explain-ai"><span class="stream-cursor"></span></div>';
      const payload = {
        headline: story ? story.headline : item.title,
        items: items.slice(0, 10).map((i) => ({ source: i.sourceName, tier: i.tier, title: i.title, published: new Date(i.published).toISOString(), summary: i.summary })),
      };
      try {
        await AI.streamBackgrounder(payload, App.state.settings, (text) => {
          const el = document.getElementById("explain-ai");
          if (el) el.innerHTML = UI.md(text) + '<span class="stream-cursor"></span>';
        }, null, {});
        const el = document.getElementById("explain-ai");
        if (el) { const c = el.querySelector(".stream-cursor"); if (c) c.remove(); }
      } catch (e) {
        const el = document.getElementById("explain-ai");
        if (el) el.innerHTML = '<p style="color:var(--red)">' + UI.esc(e.message) + "</p>";
      }
    },

    /* ============ scroll memory ============ */
    _scroll: {},
    uiScroll(path) { return App._scroll[path] || 0; },

    /* ============ wiring ============ */
    wire() {
      window.addEventListener("hashchange", () => {
        App._kbdIdx = -1;
        App.state.uiState.hlArmed = false;
        App.state.uiState.searchOpen = false;
        // Opening an item counts as reading it, however the reader got there
        // (tap, deep link, pin, share-pack import).
        const m = (location.hash || "").match(/^#\/item\/(.+?)(\?|$)/);
        if (m) App.markRead(m[1]);
        // A fresh counterpart file starts with clean tools — a filter left
        // over from Peters' page must not silently empty McClay's.
        const cpm = (location.hash || "").match(/^#\/portfolio\/([a-z]+)/);
        if (cpm && cpm[1] !== App.state.uiState.cpId) {
          App.state.uiState.cpId = cpm[1];
          App.state.uiState.cpType = "";
          App.state.uiState.cpSort = "relevance";
          App.state.uiState.cpQuery = "";
        }
        const ldm = (location.hash || "").match(/^#\/leader\/([a-z]+)/);
        if (ldm && ldm[1] !== App.state.uiState.ldId) {
          App.state.uiState.ldId = ldm[1];
          App.state.uiState.ldScope = "";
          App.state.uiState.ldSort = "relevance";
          App.state.uiState.ldQuery = "";
        }
        UI.render();
        if ((location.hash || "#/") === "#/" || location.hash === "") App.acknowledgePins();
        if ((location.hash || "").indexOf("#/desk") === 0 && (location.hash || "").indexOf("#/deskroom") !== 0) App.acknowledgeDesk();
        if ((location.hash || "").indexOf("#/deskroom") === 0 && App.state.deskMode) App.deskDraftInit(false);
      });
      window.addEventListener("scroll", () => {
        App._scroll[(location.hash || "#/").split("?")[0]] = window.scrollY;
      }, { passive: true });

      document.getElementById("btn-theme").addEventListener("click", () => {
        const cur = App.state.settings.theme;
        const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
        App.saveSettings({ theme: next });
        App.applyTheme();
      });

      document.addEventListener("click", (e) => {
        const el = e.target.closest("[data-action]");
        if (!el) return;
        const a = el.dataset.action;
        const fn = App.actions[a];
        if (fn) { e.preventDefault(); fn(el, e); }
      });
      // Keyboard activation for focusable non-button rows and cards.
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const el = e.target.closest && e.target.closest('[data-action][tabindex="0"]');
        if (!el || e.target.tagName === "BUTTON" || e.target.tagName === "A") return;
        e.preventDefault();
        const fn = App.actions[el.dataset.action];
        if (fn) fn(el, e);
      });

      document.addEventListener("change", (e) => {
        const el = e.target.closest("[data-action]");
        if (!el) return;
        if (el.dataset.action === "src-toggle") {
          const toggle = { ...App.state.settings.sourceToggle, [el.dataset.id]: el.checked };
          App.saveSettings({ sourceToggle: toggle });
          UI.toast(el.checked ? "Source on — next refresh includes it" : "Source off");
        }
        if (el.dataset.action === "wire-muted") App.setWireParam("muted", el.checked ? "1" : "");
      });

      document.addEventListener("input", (e) => {
        if (e.target.id === "wire-q") {
          clearTimeout(App._qT);
          App._qT = setTimeout(() => App.setWireParam("q", e.target.value), 250);
        }
        if (e.target.id === "cp-q") {
          clearTimeout(App._cpqT);
          App._cpqT = setTimeout(() => { App.state.uiState.cpQuery = e.target.value; UI.render(); }, 250);
        }
        if (e.target.id === "ld-q") {
          clearTimeout(App._ldqT);
          App._ldqT = setTimeout(() => { App.state.uiState.ldQuery = e.target.value; UI.render(); }, 250);
        }
        if (e.target.id === "global-q") {
          clearTimeout(App._gqT);
          App._gqT = setTimeout(() => { App.state.uiState.gq = e.target.value; UI.render(); }, 250);
        }
        if (e.target.id === "desk-md") {
          const d = App.state.uiState.deskDraft;
          if (d) {
            d.html = e.target.innerHTML;
            d.source = "edited";
            clearTimeout(App._deskT);
            App._deskT = setTimeout(() => App.deskDraftSave(), 400);
          }
        }
        if (e.target.id === "set-apikey") App.saveSettings({ apiKey: e.target.value.trim() });
        if (e.target.id === "set-relayurl") App.saveSettings({ relayUrl: e.target.value.trim() });
        if (e.target.id === "set-relaykey") App.saveSettings({ relayKey: e.target.value.trim() });
      });

      App.wireGestures();
      App.wirePullToRefresh();
      App.wireKeyboard();
      App.wireErrorSurface();
    },

    /* Pull-to-refresh: touch only, from the very top, releases into the
       staged update. The panel itself is the feedback. */
    wirePullToRefresh() {
      let startY = null, pulled = 0;
      document.addEventListener("touchstart", (e) => {
        if (window.scrollY > 0 || document.querySelector(".sheet, .sweep-panel")) { startY = null; return; }
        if (e.target.closest("input, textarea, .actionbar")) { startY = null; return; }
        startY = e.touches[0].clientY;
        pulled = 0;
      }, { passive: true });
      document.addEventListener("touchmove", (e) => {
        if (startY == null) return;
        pulled = e.touches[0].clientY - startY;
      }, { passive: true });
      document.addEventListener("touchend", () => {
        if (startY != null && pulled > 90 && window.scrollY <= 0 && !App.state.sweeping) App.stagedSweep();
        startY = null;
      }, { passive: true });
    },

    /* Desktop keyboard: j/k walk the list, o or Enter opens, s saves,
       "/" focuses the nearest search box, "." runs the update. */
    _kbdIdx: -1,
    wireKeyboard() {
      document.addEventListener("keydown", (e) => {
        if (document.body.classList.contains("locked")) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const t = document.activeElement;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) {
          if (e.key === "Escape") t.blur();
          return;
        }
        const rows = [...document.querySelectorAll(".wire-row[data-item], .card[data-action]")];
        const move = (dir) => {
          if (!rows.length) return;
          App._kbdIdx = Math.max(0, Math.min(rows.length - 1, App._kbdIdx + dir));
          rows.forEach((r) => r.classList.remove("kbd-sel"));
          const row = rows[App._kbdIdx];
          row.classList.add("kbd-sel");
          row.scrollIntoView({ block: "nearest" });
        };
        if (e.key === "j") { move(1); e.preventDefault(); }
        else if (e.key === "k") { move(-1); e.preventDefault(); }
        else if ((e.key === "o" || e.key === "Enter") && App._kbdIdx >= 0 && rows[App._kbdIdx]) {
          const row = rows[App._kbdIdx];
          const target = row.matches("[data-action]") ? row : row.querySelector("[data-action]");
          if (target) target.click();
        }
        else if (e.key === "s" && App._kbdIdx >= 0 && rows[App._kbdIdx]) {
          const btn = rows[App._kbdIdx].querySelector(".save-btn");
          if (btn) btn.click();
        }
        else if (e.key === ".") { App.stagedSweep(); }
        else if (e.key === "/") {
          const q = document.querySelector("#wire-q, #cp-q, #ld-q, #global-q");
          if (q) { q.focus(); e.preventDefault(); }
          else if ((location.hash || "#/").startsWith("#/wire")) { App.state.uiState.searchOpen = true; UI.render(); const w = document.getElementById("wire-q"); if (w) w.focus(); e.preventDefault(); }
        }
        else if (e.key === "Escape" && document.querySelector(".sheet")) { UI.closeSheet(); }
      });
    },

    /* Silent breakage is the enemy of trust: surface runtime errors as a
       quiet toast (throttled) instead of a dead button. */
    _lastErrAt: 0,
    wireErrorSurface() {
      const surface = (msg) => {
        if (Date.now() - App._lastErrAt < 8000) return;
        App._lastErrAt = Date.now();
        UI.toast("Something went wrong: " + String(msg).slice(0, 90), 5000);
      };
      window.addEventListener("error", (e) => surface(e.message || "script error"));
      window.addEventListener("unhandledrejection", (e) => surface((e.reason && e.reason.message) || e.reason || "async error"));
    },

    setWireParam(key, value) {
      const { params } = (function () {
        const hash = location.hash || "#/wire";
        const qIdx = hash.indexOf("?");
        return { params: new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : "") };
      })();
      if (value) params.set(key, value); else params.delete(key);
      const q = params.toString();
      history.replaceState(null, "", "#/wire" + (q ? "?" + q : ""));
      UI.render();
    },

    /* Swipe right = read toggle, left = save; long-press = action sheet.
       Pointer events with a vertical-intent guard so scrolling never fights. */
    wireGestures() {
      const main = document.getElementById("main");
      let start = null, row = null, moved = false, lpTimer = null;
      main.addEventListener("pointerdown", (e) => {
        // Touch only: on a computer, dragging is text selection and a long
        // press is a right-click — the app must never eat either.
        if (e.pointerType !== "touch") { row = null; return; }
        row = e.target.closest(".wire-row");
        if (!row || !e.isPrimary) { row = null; return; }
        start = { x: e.clientX, y: e.clientY };
        moved = false;
        const id = row.dataset.item;
        lpTimer = setTimeout(() => {
          if (!moved && id) {
            const item = App.itemById(id);
            if (item) { navigator.vibrate && navigator.vibrate(10); UI.longPressSheet(item); }
            row = null;
          }
        }, 500);
      });
      main.addEventListener("pointermove", (e) => {
        if (!row || !start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!moved && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
          // vertical intent: abandon
          clearTimeout(lpTimer); row = null; return;
        }
        if (Math.abs(dx) > 8) {
          moved = true;
          clearTimeout(lpTimer);
          const inner = row.querySelector(".wire-row-inner");
          inner.style.transform = "translateX(" + Math.max(-110, Math.min(110, dx)) + "px)";
        }
      });
      const finish = (e) => {
        clearTimeout(lpTimer);
        if (!row) return;
        const inner = row.querySelector(".wire-row-inner");
        const dx = e.clientX - (start ? start.x : e.clientX);
        inner.style.transform = "";
        const id = row.dataset.item;
        if (moved && Math.abs(dx) >= 72 && id) {
          if (dx > 0) {
            const wasRead = !!App.readStateFor(id).readAt;
            App.markRead(id, !wasRead);
            UI.toast(wasRead ? "Marked unread" : "Marked read");
          } else {
            App.toggleSave(id);
          }
          UI.render();
        }
        row = null; start = null; moved = false;
      };
      main.addEventListener("pointerup", finish);
      main.addEventListener("pointercancel", finish);
    },

    /* ============ actions map (delegated clicks) ============ */
    actions: {
      "nav": (el) => { location.hash = el.dataset.to; },
      "close-sheet": () => UI.closeSheet(),
      "more-sheet": () => UI.moreSheet(),
      "lock-app": () => { UI.closeSheet(); if (window.Gate) Gate.lock(); },

      "open-item": (el, e) => {
        if (e.target.closest("button")) return;
        if (String(getSelection && getSelection() || "").length) return; // selecting, not tapping
        if (e.target.closest("a")) return;
        const id = el.dataset.id;
        App.markRead(id);
        location.hash = "#/item/" + id;
      },
      "open-story": (el, e) => {
        if (e.target.closest("button")) return;
        if (String(getSelection && getSelection() || "").length) return;
        location.hash = "#/story/" + el.dataset.id;
      },

      "lens": (el) => { App.saveSettings({ lens: el.dataset.lens }); App.state.stories = null; UI.render(); },
      "wire-region": (el) => App.setWireParam("r", el.dataset.r),
      "wire-topic": (el) => { UI.closeSheet(); App.setWireParam("t", el.dataset.t); },
      "wire-unread": () => {
        const p = new URLSearchParams((location.hash.split("?")[1] || ""));
        App.setWireParam("u", p.get("u") === "1" ? "" : "1");
      },
      "wire-search": () => { App.state.uiState.searchOpen = !App.state.uiState.searchOpen; UI.render(); const q = document.getElementById("wire-q"); if (q) q.focus(); },
      "filter-sheet": () => {
        const p = new URLSearchParams((location.hash.split("?")[1] || ""));
        UI.filterSheet(p);
      },

      "toggle-save": (el) => { UI.closeSheet(); App.toggleSave(el.dataset.id); },
      "unsave": (el) => App.unsave(el.dataset.id),
      "saved-tab": (el) => { App.state.uiState.savedTab = el.dataset.t; UI.render(); },
      "del-hl": (el) => App.deleteHighlight(el.dataset.id),
      "share-pack": () => App.sharePack(),
      "import-pack": () => App.importPack(),

      "toggle-hl": () => { App.state.uiState.hlArmed = !App.state.uiState.hlArmed; UI.render(); },
      "mark-all-read": () => {
        const since = App.state.catchup ? App.state.catchup.since : 0;
        for (const i of App.state.items) if (i.published > since) App.markRead(i.id);
        UI.render();
      },

      "mute-topic": (el) => {
        UI.closeSheet();
        const m = App.state.settings.muted;
        if (m.topics.indexOf(el.dataset.t) < 0) m.topics.push(el.dataset.t);
        App.saveSettings({ muted: m });
        App.state.stories = null;
        UI.toast("Muted: " + Fatopics.label(el.dataset.t) + " (pins still show)");
        UI.render();
      },
      "mute-source": (el) => {
        UI.closeSheet();
        const m = App.state.settings.muted;
        if (m.sources.indexOf(el.dataset.s) < 0) m.sources.push(el.dataset.s);
        App.saveSettings({ muted: m });
        UI.toast("Source muted");
        UI.render();
      },
      "clear-mutes": () => { App.saveSettings({ muted: { topics: [], sources: [] } }); App.state.stories = null; UI.render(); },

      "copy-link": async (el) => {
        UI.closeSheet();
        const i = App.itemById(el.dataset.id);
        if (!i) return;
        try { await navigator.clipboard.writeText(i.title + "\n" + i.link); UI.toast("Copied"); }
        catch (_) { UI.toast("Copy failed"); }
      },

      "sweep-now": () => App.stagedSweep(),
      "staged-sweep": () => App.stagedSweep(),
      "sweep-hide": () => UI.sweepHide(),
      "live-boost": async () => {
        UI.toast("Live boost running…");
        try {
          const res = await Corpus.liveBoost(App.state.settings);
          App.setItems((await Store.getAll("items")).sort((a, b) => b.published - a.published));
          App.state.rev++; App.state.stories = null;
          UI.toast("Live boost: " + res.added + " new from " + res.polled + " feeds");
          UI.render();
        } catch (e) { UI.toast("Boost failed: " + e.message, 5000); }
      },
      "export-archive": async () => {
        const data = await Store.exportAll();
        const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "interdesk-archive-" + new Date().toISOString().slice(0, 10) + ".json";
        a.click();
      },
      "import-archive": () => {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "application/json";
        input.onchange = async () => {
          try {
            const res = await Store.importAll(JSON.parse(await input.files[0].text()));
            if (res.settings) await App.saveSettings(res.settings);
            App.setItems((await Store.getAll("items")).sort((a, b) => b.published - a.published));
            App.state.saved = await Store.getAll("saved");
            App.state.highlights = await Store.getAll("highlights");
            App.state.rev++; App.state.stories = null;
            UI.toast("Imported: " + res.items + " items, " + res.saved + " saved, " + res.highlights + " highlights");
            UI.render();
          } catch (e) { UI.toast("Import failed: " + e.message, 6000); }
        };
        input.click();
      },

      "set-theme": (el) => { App.saveSettings({ theme: el.dataset.v }); App.applyTheme(); UI.render(); },
      "set-font": (el) => { App.saveSettings({ fontScale: parseFloat(el.dataset.v) }); App.applyFont(); UI.render(); },
      "set-lens-default": (el) => { App.saveSettings({ lens: el.dataset.v }); App.state.stories = null; UI.render(); },
      "set-gate": (el) => { if (window.Gate) Gate.setMode(el.dataset.v); UI.render(); },

      "desk-unlock": async () => {
        const key = (document.getElementById("set-deskkey") || {}).value || "";
        if (!key) return UI.toast("Paste the desk key first");
        if (!App.state.settings.relayUrl) return UI.toast("Set the relay URL first");
        await App.saveSettings({ deskKey: key.trim() });
        try {
          // Verify with a WRITE: reads succeed on the reader key alone, which
          // would bless a wrong desk key. Re-putting the current desk line is
          // a no-op with write-auth semantics.
          await Relay.putMeta(App.state.deskMeta || { text: "", at: Date.now() });
          App.state.deskMode = true;
          UI.toast("Desk mode on");
          await App.syncRelay(true);
        } catch (e) {
          await App.saveSettings({ deskKey: "" });
          UI.toast("Key rejected: " + e.message, 5000);
        }
        UI.render();
      },
      "desk-lock": async () => {
        await App.saveSettings({ deskKey: "" });
        App.state.deskMode = false;
        UI.toast("Desk locked");
        UI.render();
      },

      "pin-sheet": (el) => {
        UI.closeSheet();
        const id = el.dataset.id;
        const scope = el.dataset.scope || "item";
        const src = scope === "story" ? App.storyById(id) : App.itemById(id);
        if (!src) return;
        UI.pinSheet({ id: scope === "story" ? (App.storyById(id).itemIds[0] || id) : id, scope, title: src.headline || src.title });
      },
      "edit-pin": (el) => {
        const pin = App.state.pins.find((p) => p.itemId === el.dataset.id);
        if (pin) UI.pinSheet({ id: pin.itemId, scope: "item", title: pin.title });
      },
      "pin-save": async (el) => {
        const id = el.dataset.id;
        const note = (document.getElementById("pin-note") || {}).value || "";
        const priority = (document.querySelector("#pin-priority button.active") || {}).dataset?.p || "priority";
        const ttl = parseInt((document.querySelector("#pin-ttl button.active") || {}).dataset?.s || "604800", 10);
        const item = App.itemById(id) || App.savedById(id);
        const story = App.storyById(id);
        const src = item || story;
        if (!src) return UI.toast("Can't resolve that item");
        const pin = {
          itemId: id, kind: item ? "item" : "story",
          title: item ? item.title : story.headline,
          link: (item && item.link) || "",
          source: item ? item.sourceName : (story && story.topic) || "",
          bucket: (item && item.region) || (story && (story.regions || [])[0]) || "global",
          note: note.trim(), priority,
          at: Date.now(), expiresAt: Date.now() + ttl * 1000,
        };
        try {
          // Exactly one Lead: a new Lead demotes the previous one.
          if (priority === "lead") {
            const prevLead = App.state.pins.find((p) => p.priority === "lead" && p.itemId !== id);
            if (prevLead) await Relay.putPin({ ...prevLead, priority: "priority" }, Math.max(3600, Math.round(((prevLead.expiresAt || Date.now() + 604800000) - Date.now()) / 1000)));
          }
          await Relay.putPin(pin, ttl);
          UI.closeSheet();
          UI.toast("Pinned");
          await App.syncRelay(true);
        } catch (e) { UI.toast("Pin failed: " + e.message, 5000); }
      },
      "unpin": async (el) => {
        try {
          await Relay.delPin(el.dataset.id);
          UI.toast("Unpinned");
          await App.syncRelay(true);
        } catch (e) { UI.toast("Unpin failed: " + e.message, 5000); }
      },

      "save-desk-meta": async () => {
        const text = (document.getElementById("desk-meta") || {}).value || "";
        try {
          await Relay.putMeta({ text: text.trim(), at: Date.now() });
          UI.toast("Desk line set");
          await App.syncRelay(true);
        } catch (e) { UI.toast("Failed: " + e.message, 5000); }
      },
      "clear-desk-meta": async () => {
        try { await Relay.putMeta({ text: "", at: Date.now() }); await App.syncRelay(true); }
        catch (e) { UI.toast("Failed: " + e.message, 5000); }
      },

      "clock-slot": (el) => {
        UI.clockZoneSheet(Number(el.dataset.slot) || 0);
      },
      "clock-resync": async () => {
        // The ceremony narrates itself in the strip; no toast on top of it.
        await Clock.resync();
        UI.render();
      },
      "clock-zone-set": async (el) => {
        const slot = Number(el.dataset.slot) || 0;
        const zones = (App.state.settings.clockZones || ["canberra", "washington", "london"]).slice();
        zones[slot] = el.dataset.zone;
        await App.saveSettings({ clockZones: zones });
        Clock.setSlots(zones);
        UI.closeSheet();
      },

      /* An already-flagged item opens its manage sheet, not a duplicate flag.
         Saved and pinned stubs flag too — never a silent dead button. */
      "respond-flag": (el) => {
        UI.closeSheet();
        const id = el.dataset.id;
        const existing = App.respondFor(id);
        if (existing) return UI.respondManageSheet(existing);
        const item = App.itemById(id) || App.savedById(id) || App.pinnedItemStub(id);
        if (!item) return UI.toast("This item is no longer in the archive");
        UI.respondSheet(item);
      },
      "respond-save": async (el) => {
        const id = el.dataset.id;
        const item = App.itemById(id);
        const note = (document.getElementById("resp-note") || {}).value || "";
        // The sheet lets the desk say WHO the response answers; default to the
        // item's first tagged counterpart.
        const picked = document.querySelector("#resp-cp .active");
        const cp = (item.counterparts || [])[0];
        const flag = {
          itemId: id, counterpartId: picked ? picked.dataset.cp : (cp ? cp.id : ""),
          title: item.title, link: item.link,
          flaggedAt: Date.now(), status: "open", note: note.trim(),
          respondedUrl: null, respondedAt: null,
        };
        try {
          await Relay.putRespond(flag);
          UI.closeSheet();
          UI.toast("Flagged — it's in the response queue");
          await App.syncRelay(true);
          UI.render();
        } catch (e) { UI.toast("Failed: " + e.message, 5000); }
      },
      "respond-done": (el) => {
        const flag = App.respondFor(el.dataset.id);
        if (flag) UI.respondDoneSheet(flag);
      },
      "respond-done-save": async (el) => {
        const flag = App.respondFor(el.dataset.id);
        if (!flag) return;
        const url = (document.getElementById("resp-url") || {}).value || "";
        try {
          await Relay.putRespond({ ...flag, status: "done", respondedUrl: url.trim() || null, respondedAt: Date.now() });
          UI.closeSheet();
          UI.toast("Marked responded");
          await App.syncRelay(true);
        } catch (e) { UI.toast("Failed: " + e.message, 5000); }
      },
      "respond-clear": async (el) => {
        try {
          await Relay.delRespond(el.dataset.id);
          UI.closeSheet();
          UI.toast("Flag cleared");
          await App.syncRelay(true);
          UI.render();
        } catch (e) { UI.toast("Failed: " + e.message, 5000); }
      },

      "cp-authored": () => { App.state.uiState.cpCoverage = false; App.state.uiState.cpType = ""; UI.render(); },
      "cp-coverage": () => { App.state.uiState.cpCoverage = true; UI.render(); },
      "cp-type": (el) => { App.state.uiState.cpType = el.dataset.t; UI.render(); },
      "cp-sort": (el) => { App.state.uiState.cpSort = el.dataset.s; UI.render(); },
      "ld-scope": (el) => { App.state.uiState.ldScope = el.dataset.s; UI.render(); },
      "ld-sort": (el) => { App.state.uiState.ldSort = el.dataset.s; UI.render(); },

      "run-brief": () => App.runBrief(),
      "desk-regenerate": () => App.deskDraftInit(true),
      "desk-insert-sheet": () => UI.deskInsertSheet(),
      "desk-insert-item": (el) => {
        UI.closeSheet();
        const item = App.itemById(el.dataset.id) || App.savedById(el.dataset.id);
        if (!item) return;
        const src2 = item.via || item.sourceName;
        const okLink = /^https?:\/\//i.test(item.link || "");
        const href = okLink ? item.link : "#/item/" + item.id;
        const line = '<ul><li><a href="' + href.replace(/"/g, "&quot;") + '">'
          + String(item.title).replace(/&/g, "&amp;").replace(/</g, "&lt;")
          + "</a> — " + String(src2).replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</li></ul>";
        App.deskInsert(line);
      },
      "desk-snippet": (el) => {
        const SNIPPETS = {
          heading: "<h2>Section title</h2><p></p>",
          read: "<h2>Read these</h2><ul><li></li></ul>",
          running: "<h2>Running stories</h2><p></p>",
          coming: "<h2>Coming up</h2><ul><li></li></ul>",
          quote: "<blockquote></blockquote>",
          callout: '<div class="callout">Worth knowing: </div>',
          divider: "<hr>",
        };
        UI.closeSheet();
        App.deskInsert(SNIPPETS[el.dataset.snip] || "");
      },
      "desk-ship": () => App.deskShip(),
      "desk-history-view": async (el) => {
        const past = (App.state.uiState.deskHistory || []).find((b) => b.id === el.dataset.id);
        if (past) UI.deskHistorySheet(past);
      },
      "desk-history-reuse": (el) => {
        const past = (App.state.uiState.deskHistory || []).find((b) => b.id === el.dataset.id);
        const d = App.state.uiState.deskDraft;
        if (!past || !d) return;
        UI.closeSheet();
        d.md = past.md;
        d.source = "edited";
        App.deskDraftSave();
        UI.toast("Loaded the " + past.date + " desk into today's draft");
        UI.render();
      },
      "explain": (el) => App.explain(el.dataset.scope === "story" ? el.dataset.id : el.dataset.id, el.dataset.scope),
      "font-cycle": () => {
        const steps = [0.9, 1, 1.1, 1.25];
        const cur = steps.indexOf(App.state.settings.fontScale);
        const next = steps[(cur + 1) % steps.length];
        App.saveSettings({ fontScale: next });
        App.applyFont();
      },
    },
  };

  // Sentence tap-to-mark (delegated; only when armed).
  document.addEventListener("click", async (e) => {
    if (!App.state.uiState.hlArmed) return;
    const sent = e.target.closest(".sent");
    if (!sent) return;
    e.preventDefault();
    const on = await App.toggleHighlight(sent.dataset.ref, sent.dataset.sh, parseInt(sent.dataset.si, 10), sent.textContent.trim());
    sent.classList.toggle("hl", on);
  });

  window.App = App;
  document.addEventListener("DOMContentLoaded", () => {
    App.boot().catch((e) => {
      console.error(e);
      const main = document.getElementById("main");
      if (main) {
        main.innerHTML = '<div class="empty-state"><div class="big">Boot failed</div><span id="boot-err"></span></div>';
        const el = document.getElementById("boot-err");
        if (el) el.textContent = (e && e.message) || "";
      }
    });
  });
})();
