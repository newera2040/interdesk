/* clock.js — the masthead world clock.

   The display must be right even when the device clock is not, so the module
   estimates true UTC with simplified NTP over fetch (Cristian's algorithm):
   a discarded warm-up request opens the connection, then a burst of samples
   rides the keep-alive; each sample halves its round trip, and the sample
   with the SHORTEST round trip wins — queuing is asymmetric, so the fastest
   exchange carries the least error. Honest uncertainty is ±RTT/2 of that
   winning sample.

   Between syncs the corrected clock anchors to performance.now() (monotonic,
   immune to system clock steps). performance.now() stalls through device
   sleep on iOS/macOS, so every tick cross-checks Δdate against Δperf since
   the anchor; divergence means a sleep or a clock step happened — the display
   falls back to the device clock plus the last known offset and a resync
   fires. Ticks aim at the true second boundary (self-correcting setTimeout,
   never an accumulating interval) and stop entirely while the tab is hidden —
   visibility/pageshow/focus repaint from scratch and resync if stale.

   Time sources, in order (probed live 8 Aug 2026):
   1. the desk's own relay /time — a Cloudflare edge a few ms away, no auth;
   2. time.akamai.com/?ms — ms-true body, CORS, explicit no-store, ~38 ms RTT;
   3. use.ntpjs.org — µs-precision JSON, CORS *, needs a cache-buster;
   4. cloudflare.com/cdn-cgi/trace — seconds only (ts= ends .000); coarse
      last resort, ±500 ms floor. timeapi.io is deliberately ABSENT: its
      clock measured 22 minutes wrong. If every source fails, the device
      clock stands and the status says so — never pretend to a sync. */
(function () {
  /* Curated zone registry — IANA ids and DST notes verified 8 Aug 2026.
     Canberra is Australia/Sydney (Australia/Canberra is a deprecated alias);
     Geneva is Europe/Zurich (there is no Europe/Geneva); Fiji and Samoa have
     both abolished DST; Kyiv still changes clocks. Re-verify with the rest of
     the registries after the 7 Nov 2026 election. */
  const ZONES = [
    { id: "canberra", city: "Canberra", iana: "Australia/Sydney", country: "Australia" },
    { id: "suva", city: "Suva", iana: "Pacific/Fiji", country: "Fiji" },
    { id: "apia", city: "Apia", iana: "Pacific/Apia", country: "Samoa" },
    { id: "nukualofa", city: "Nukuʻalofa", iana: "Pacific/Tongatapu", country: "Tonga" },
    { id: "honiara", city: "Honiara", iana: "Pacific/Guadalcanal", country: "Solomon Islands" },
    { id: "portmoresby", city: "Port Moresby", iana: "Pacific/Port_Moresby", country: "Papua New Guinea" },
    { id: "tarawa", city: "Tarawa", iana: "Pacific/Tarawa", country: "Kiribati" },
    { id: "rarotonga", city: "Rarotonga", iana: "Pacific/Rarotonga", country: "Cook Islands" },
    { id: "honolulu", city: "Honolulu", iana: "Pacific/Honolulu", country: "United States" },
    { id: "washington", city: "Washington DC", short: "Washington", iana: "America/New_York", country: "United States" },
    { id: "london", city: "London", iana: "Europe/London", country: "United Kingdom" },
    { id: "brussels", city: "Brussels", iana: "Europe/Brussels", country: "Belgium" },
    { id: "geneva", city: "Geneva", iana: "Europe/Zurich", country: "Switzerland" },
    { id: "kyiv", city: "Kyiv", iana: "Europe/Kyiv", country: "Ukraine" },
    { id: "moscow", city: "Moscow", iana: "Europe/Moscow", country: "Russia" },
    { id: "delhi", city: "New Delhi", iana: "Asia/Kolkata", country: "India" },
    { id: "beijing", city: "Beijing", iana: "Asia/Shanghai", country: "China" },
    { id: "seoul", city: "Seoul", iana: "Asia/Seoul", country: "South Korea" },
    { id: "tokyo", city: "Tokyo", iana: "Asia/Tokyo", country: "Japan" },
    { id: "utc", city: "UTC", iana: "Etc/UTC", country: "Coordinated Universal Time" },
  ];
  const NZ_IANA = "Pacific/Auckland";
  const DEFAULT_SLOTS = ["canberra", "washington", "london"];

  const SAMPLES = 5;
  const SAMPLE_GAP_MS = 120;
  const RESYNC_MS = 10 * 60 * 1000;     // cadence while visible
  const STALE_MS = 5 * 60 * 1000;       // resync on return if older than this
  const DIVERGE_MS = 120;               // sleep/clock-step detection threshold

  const st = {
    synced: false,
    epochAtPerf: 0,     // corrected epoch ms at performance.now() === 0
    offset: 0,          // server - device, for the fallback path
    uncertainty: null,  // ±ms of the winning sample
    source: "",
    syncedAt: 0,
    anchorDate: 0,
    anchorPerf: 0,
    failures: 0,
    slots: DEFAULT_SLOTS.slice(),
    tickT: null,
    resyncT: null,
    syncing: false,
    getSettings: () => ({}),
  };

  function now() {
    if (st.synced) return st.epochAtPerf + performance.now();
    return Date.now() + st.offset;
  }

  function diverged() {
    if (!st.synced) return false;
    const dd = Date.now() - st.anchorDate;
    const dp = performance.now() - st.anchorPerf;
    return Math.abs(dd - dp) > DIVERGE_MS;
  }

  /* ---- sources ---- */

  /* Every read is bounded: an unanswered request must fail, never pend — a
     blackholed cell connection would otherwise wedge st.syncing forever and
     take the whole resync chain with it. */
  async function timedFetch(url) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
      return await fetch(url, { cache: "no-store", signal: ac.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function readRelay(url) {
    const r = await timedFetch(url.replace(/\/+$/, "") + "/time");
    if (!r.ok) throw new Error("relay " + r.status);
    const j = await r.json();
    if (typeof j.now !== "number" || !isFinite(j.now)) throw new Error("relay body");
    return { ms: j.now, floor: 0 };
  }
  async function readAkamai() {
    const r = await timedFetch("https://time.akamai.com/?ms");
    if (!r.ok) throw new Error("akamai " + r.status);
    const t = parseFloat(await r.text());
    if (!isFinite(t)) throw new Error("akamai body");
    return { ms: t * 1000, floor: 0 };
  }
  async function readNtpjs() {
    const r = await timedFetch("https://use.ntpjs.org/v1/time.json?_=" + Date.now());
    if (!r.ok) throw new Error("ntpjs " + r.status);
    const j = await r.json();
    if (typeof j.now !== "number" || !isFinite(j.now)) throw new Error("ntpjs body");
    return { ms: j.now * 1000, floor: 0 };
  }
  async function readCfTrace() {
    const r = await timedFetch("https://www.cloudflare.com/cdn-cgi/trace");
    if (!r.ok) throw new Error("cf " + r.status);
    const m = /(?:^|\n)ts=(\d+(?:\.\d+)?)/.exec(await r.text());
    if (!m) throw new Error("cf body");
    const t = parseFloat(m[1]);
    if (!isFinite(t)) throw new Error("cf body");
    // ts= is second-TRUNCATED (measured: true time sits anywhere in [ts, ts+1)),
    // so centre the estimate; the ±500 floor is then an honest bound.
    return { ms: (t + 0.5) * 1000, floor: 500 };
  }

  function sources() {
    const list = [];
    const settings = st.getSettings() || {};
    if (settings.relayUrl) list.push({ name: "relay", read: () => readRelay(settings.relayUrl) });
    list.push({ name: "akamai", read: readAkamai });
    list.push({ name: "ntpjs", read: readNtpjs });
    list.push({ name: "cloudflare", read: readCfTrace });
    return list;
  }

  /* One source, Cristian's algorithm: warm-up, then a min-RTT burst.
     `pace` slows the burst so the verification ceremony can show each real
     sample landing; the measurements themselves are untouched. */
  async function sampleSource(src, onSample, pace) {
    try { await src.read(); } catch (_) { /* warm-up may fail; the burst decides */ }
    let best = null;
    for (let i = 0; i < SAMPLES; i++) {
      const d1 = Date.now();
      const p1 = performance.now();
      const res = await src.read();
      const p4 = performance.now();
      const rtt = p4 - p1;
      if (!best || rtt < best.rtt) best = { rtt, res, d1, p1, p4, i };
      if (onSample) onSample(i, Math.round(rtt));
      if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, Math.max(SAMPLE_GAP_MS, (pace || 0) - rtt)));
    }
    // The server read its clock mid-flight; project it to the sample's end.
    const correctedAtP4 = best.res.ms + best.rtt / 2;
    return {
      epochAtPerf: correctedAtP4 - best.p4,
      offset: correctedAtP4 - (best.d1 + (best.p4 - best.p1)),
      uncertainty: Math.round(best.rtt / 2 + best.res.floor),
      bestIndex: best.i,
    };
  }

  const SOURCE_LABELS = { relay: "the desk relay", akamai: "Akamai time", ntpjs: "NTP.js", cloudflare: "Cloudflare" };

  /* The verification ceremony: a deliberate, staged check (~4 s) whose every
     beat is real work — reaching the source, five live samples with their
     round trips, locking to the fastest exchange. Certainty, shown. */
  function ceremonyUI() {
    if (!refs) return null;
    const label = refs.bar.querySelector(".clock-nz .ck-city");
    const timeRow = refs.bar.querySelector(".clock-nz .ck-time");
    if (!label || !timeRow) return null;
    refs.bar.classList.add("syncing");
    let samplesEl = null;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    return {
      async stage(text, minMs) {
        label.textContent = text;
        label.classList.add("ck-stage");
        await wait(minMs || 0);
      },
      samplesStart() {
        samplesEl = document.createElement("span");
        samplesEl.className = "ck-samples";
        samplesEl.setAttribute("aria-hidden", "true");
        for (let i = 0; i < SAMPLES; i++) samplesEl.appendChild(document.createElement("i"));
        timeRow.appendChild(samplesEl);
      },
      sample(i) {
        if (samplesEl && samplesEl.children[i]) samplesEl.children[i].classList.add("on");
      },
      async lock(bestIndex, uncertainty, sourceName) {
        if (samplesEl && samplesEl.children[bestIndex]) samplesEl.children[bestIndex].classList.add("best");
        await this.stage("Locking to the fastest exchange", 650);
        refs.bar.classList.add("locked");
        timeRow.classList.add("ck-settle");
        await this.stage(`Exact to ±${uncertainty} ms · ${SOURCE_LABELS[sourceName] || sourceName}`, 1500);
      },
      async fail() {
        await this.stage("No time server reachable — device clock", 1600);
      },
      end() {
        refs.bar.classList.remove("syncing", "locked");
        timeRow.classList.remove("ck-settle");
        if (samplesEl) samplesEl.remove();
        label.classList.remove("ck-stage");
        label.textContent = "New Zealand";
      },
    };
  }

  async function sync(ceremony) {
    if (st.syncing) {
      // A manual verify during a quiet background sync must not vanish:
      // queue one follow-up ceremony for when the in-flight sync settles.
      if (ceremony) st.queuedCeremony = true;
      return;
    }
    st.syncing = true;
    const ui = ceremony ? ceremonyUI() : null;
    try {
      for (const src of sources()) {
        try {
          if (ui) {
            await ui.stage("Reaching " + (SOURCE_LABELS[src.name] || src.name), 850);
            ui.samplesStart();
          }
          const s = await sampleSource(src, ui ? (i) => ui.sample(i) : null, ui ? 300 : 0);
          st.epochAtPerf = s.epochAtPerf;
          st.offset = s.offset;
          st.uncertainty = s.uncertainty;
          st.source = src.name;
          st.synced = true;
          st.syncedAt = now();
          st.anchorDate = Date.now();
          st.anchorPerf = performance.now();
          st.failures = 0;
          if (ui) await ui.lock(s.bestIndex, s.uncertainty, src.name);
          paint();
          return;
        } catch (_) { /* next source */ }
      }
      // Every source failed: the device clock stands, and we say so.
      st.synced = false;
      st.uncertainty = null;
      st.source = "";
      st.failures++;
      if (ui) await ui.fail();
    } finally {
      if (ui) ui.end();
      st.syncing = false;
      if (st.pendingSlots) { const s = st.pendingSlots; st.pendingSlots = null; Clock.setSlots(s); }
      try { paint(); } catch (_) { /* never let a paint error kill the chain */ }
      scheduleResync();
      if (st.queuedCeremony) {
        st.queuedCeremony = false;
        setTimeout(() => sync(true), 80);
      }
    }
  }

  function scheduleResync() {
    clearTimeout(st.resyncT);
    const backoff = st.failures ? Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, st.failures - 1)) : RESYNC_MS;
    // Always re-arm from the timer itself: if sync() bails on the syncing
    // guard, its finally never runs and the chain would otherwise die here.
    st.resyncT = setTimeout(() => {
      if (!document.hidden) sync();
      if (st.syncing || document.hidden) scheduleResync();
    }, backoff);
  }

  /* ---- formatting (cached Intl per zone; DST handled by the tzdb) ---- */

  const fmts = new Map();
  function fmt(iana, opts, key) {
    const k = iana + "|" + key;
    if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat("en-NZ", { timeZone: iana, ...opts }));
    return fmts.get(k);
  }
  function parts(iana, opts, key, ms) {
    const out = {};
    for (const p of fmt(iana, opts, key).formatToParts(new Date(ms))) out[p.type] = p.value;
    return out;
  }
  function bigParts(ms) {
    return parts(NZ_IANA, { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short" }, "big", ms);
  }
  function smallParts(iana, ms) {
    return parts(iana, { hour: "numeric", minute: "2-digit", hour12: true, weekday: "short" }, "small", ms);
  }

  /* ---- DOM ---- */

  let refs = null;

  function zoneById(id) { return ZONES.find((z) => z.id === id) || ZONES[0]; }

  /* Ids validated against the registry everywhere they enter — a renamed or
     corrupt persisted id must fall back loudly to defaults, never silently
     render as Canberra. Per-slot fallback keeps the user's other choices. */
  function sanitizeSlots(ids) {
    const arr = Array.isArray(ids) ? ids : [];
    return DEFAULT_SLOTS.map((dflt, i) =>
      ZONES.some((z) => z.id === arr[i]) ? arr[i] : dflt);
  }

  function build() {
    const bar = document.getElementById("clockbar");
    if (!bar) return;
    const slotHtml = st.slots.map((id, i) => {
      const z = zoneById(id);
      return `<button class="clock clock-slot" data-action="clock-slot" data-slot="${i}"
        title="${z.city} · tap to change this clock">
        <span class="ck-city" data-ck-city="${i}">${z.short || z.city}</span>
        <span class="ck-time"><span data-ck-time="${i}">–:––</span><span class="ck-day" data-ck-day="${i}"></span></span>
      </button>`;
    }).join("");
    bar.innerHTML = `<button class="clock clock-nz" id="clock-nz" data-action="clock-resync" title="Verify the clock against a time server">
        <span class="ck-city">New Zealand</span>
        <span class="ck-time ck-nz-time"><span id="ck-nz-hms">–:––:––</span><span class="ck-ampm" id="ck-nz-ampm"></span><span class="ck-zone" id="ck-nz-zone"></span></span>
      </button>` + slotHtml;
    refs = {
      hms: document.getElementById("ck-nz-hms"),
      ampm: document.getElementById("ck-nz-ampm"),
      zone: document.getElementById("ck-nz-zone"),
      bar,
      slots: st.slots.map((_, i) => ({
        city: bar.querySelector(`[data-ck-city="${i}"]`),
        time: bar.querySelector(`[data-ck-time="${i}"]`),
        day: bar.querySelector(`[data-ck-day="${i}"]`),
      })),
    };
    paint();
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function paint() {
    if (!refs) return;
    const ms = now();
    const nz = bigParts(ms);
    setText(refs.hms, `${nz.hour}:${nz.minute}:${nz.second}`);
    setText(refs.ampm, (nz.dayPeriod || "").toUpperCase());
    setText(refs.zone, nz.timeZoneName || "");
    st.slots.forEach((id, i) => {
      const z = zoneById(id);
      const p = smallParts(z.iana, ms);
      const r = refs.slots[i];
      if (!r) return;
      setText(r.city, z.short || z.city);
      setText(r.time, `${p.hour}:${p.minute} ${(p.dayPeriod || "").toUpperCase()}`);
      // Show the weekday only when it differs from NZ's — the glanceable
      // "it's still yesterday in Washington" cue.
      const nzDay = parts(NZ_IANA, { weekday: "short" }, "wd", ms).weekday;
      setText(r.day, p.weekday !== nzDay ? p.weekday : "");
    });
    const status = st.synced
      ? `Synced to ${st.source} ±${st.uncertainty} ms`
      : "Device clock (time server unreachable)";
    if (refs.bar.getAttribute("title") !== status) refs.bar.setAttribute("title", status);
    refs.bar.classList.toggle("unsynced", !st.synced);
  }

  function tick() {
    clearTimeout(st.tickT);
    if (document.hidden) return; // repaint happens on return to visibility
    if (diverged()) {
      // A sleep or a clock step happened; which one is locally unknowable.
      // Fall back to the device clock plus last offset and resync now.
      st.synced = false;
      sync();
    }
    try { paint(); } catch (_) { /* a paint error must never kill the chain */ }
    const delay = 1000 - (now() % 1000) + 2;
    st.tickT = setTimeout(tick, isFinite(delay) && delay > 0 ? delay : 1000);
  }

  function onVisible() {
    if (document.hidden) return;
    try { paint(); } catch (_) { /* repaint best-effort */ }
    tick();
    if (diverged() || now() - st.syncedAt > STALE_MS) sync();
  }

  const Clock = {
    zones() { return ZONES; },
    slots() { return st.slots.slice(); },
    status() { return { synced: st.synced, uncertainty: st.uncertainty, source: st.source, syncedAt: st.syncedAt }; },
    now,
    /* Manual verification always runs the visible ceremony; the background
       cadence and visibility resyncs stay quiet. */
    resync() { return sync(true); },

    setSlots(ids) {
      const clean = sanitizeSlots(ids);
      // Rebuilding the bar mid-ceremony detaches the ceremony's DOM refs;
      // hold the change until the sync settles.
      if (st.syncing) { st.pendingSlots = clean; return; }
      st.slots = clean;
      build();
    },

    init(opts) {
      st.getSettings = (opts && opts.getSettings) || st.getSettings;
      st.slots = sanitizeSlots((st.getSettings() || {}).clockZones);
      build();
      tick();
      sync(true); // the opening verification runs in full view
      document.addEventListener("visibilitychange", onVisible);
      // iOS standalone PWAs historically misfire visibilitychange, and bfcache
      // restores resume an old heap — pageshow and focus cover both.
      window.addEventListener("pageshow", onVisible);
      window.addEventListener("focus", onVisible);
    },
  };

  window.Clock = Clock;
})();
