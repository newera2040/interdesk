/* ui.js — every view is a pure function returning an HTML string; UI.render
   swaps #main and re-wires nothing (all events are delegated). One broken
   view must never blank the desk: renderView is wrapped in try/catch. */
(function () {
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "");

  /* ---- tiny markdown (headings, lists, tables, quotes, bold/italic, links,
     code) — escapes first, formats second. */
  function mdInline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\*([^*]+)\*/g, "<i>$1</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[([^\]]+)\]\((#\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  }
  function md(src) {
    const lines = esc(src || "").split("\n");
    const out = [];
    let list = null, table = false;
    const closeAll = () => {
      if (list) { out.push(list === "ul" ? "</ul>" : "</ol>"); list = null; }
      if (table) { out.push("</table>"); table = false; }
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
        closeAll();
        const h = Math.min(4, m[1].length + 1);
        out.push(`<h${h}>${mdInline(m[2])}</h${h}>`);
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (table) { out.push("</table>"); table = false; }
        if (list !== "ul") { if (list) out.push("</ol>"); out.push("<ul>"); list = "ul"; }
        out.push("<li>" + mdInline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      } else if (/^\s*\d+\.\s+/.test(line)) {
        if (table) { out.push("</table>"); table = false; }
        if (list !== "ol") { if (list) out.push("</ul>"); out.push("<ol>"); list = "ol"; }
        out.push("<li>" + mdInline(line.replace(/^\s*\d+\.\s+/, "")) + "</li>");
      } else if (/^\s*\|/.test(line)) {
        if (list) { out.push(list === "ul" ? "</ul>" : "</ol>"); list = null; }
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        const cells = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|");
        if (!table) { out.push("<table>"); table = true; }
        out.push("<tr>" + cells.map((c) => "<td>" + mdInline(c.trim()) + "</td>").join("") + "</tr>");
      } else if (/^\s*!!\s?/.test(line)) {
        closeAll();
        out.push('<div class="callout">' + mdInline(line.replace(/^\s*!!\s?/, "")) + "</div>");
      } else if (/^\s*>\s?/.test(line)) {
        closeAll();
        out.push("<blockquote>" + mdInline(line.replace(/^\s*>\s?/, "")) + "</blockquote>");
      } else if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
        closeAll(); out.push("<hr>");
      } else if (line.trim() === "") {
        closeAll();
      } else {
        closeAll(); out.push("<p>" + mdInline(line) + "</p>");
      }
    }
    closeAll();
    return out.join("\n");
  }

  /* ---- time ---- */
  const NZ_TIME = new Intl.DateTimeFormat("en-NZ", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Pacific/Auckland" });
  const NZ_DAY = new Intl.DateTimeFormat("en-NZ", { weekday: "long", day: "numeric", month: "long", timeZone: "Pacific/Auckland" });
  function timeShort(ts) { return ts ? NZ_TIME.format(new Date(ts)).toUpperCase() : ""; }
  function dayLabel(ts) { return ts ? NZ_DAY.format(new Date(ts)) : ""; }
  function ago(ts) {
    if (!ts) return "";
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + " h ago";
    return Math.round(h / 24) + " d ago";
  }

  /* ---- sentence splitting for tap-to-mark ---- */
  function splitSentences(text) {
    const parts = String(text || "").match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g);
    return (parts || []).map((s) => s.trim()).filter(Boolean);
  }
  function normSent(s) { return s.toLowerCase().replace(/\s+/g, " ").trim(); }
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }
  function sentHash(s) { return fnv(normSent(s)); }

  function sentenceSpans(text, refId, hlByHash) {
    return splitSentences(text).map((s, idx) => {
      const h = sentHash(s);
      const on = hlByHash && hlByHash.has(h) ? " hl" : "";
      return `<span class="sent${on}" data-si="${idx}" data-sh="${h}" data-ref="${esc(refId)}">${esc(s)}</span> `;
    }).join("");
  }

  /* ---- shared fragments ---- */

  const BOOKMARK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4.2-5.5 4.2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const BOOKMARK_FILL = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4.2-5.5 4.2z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 20 20"/></svg>';
  const ICON_FILTER = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="10" cy="7" r="1.9" fill="var(--paper)"/><circle cx="15" cy="12" r="1.9" fill="var(--paper)"/><circle cx="8" cy="17" r="1.9" fill="var(--paper)"/></svg>';

  /* The typographic country mark — a dateline tag, not a picture of a flag. */
  function cmark(person, big) {
    if (!person || !person.code) return "";
    return `<span class="cmark${big ? " big" : ""}" aria-hidden="true">${esc(person.code)}</span>`;
  }

  function saveBtn(id, cls) {
    const saved = App.isSaved(id);
    return `<button class="save-btn ${saved ? "on" : ""} ${cls || ""}" data-action="toggle-save" data-id="${esc(id)}"
      aria-label="${saved ? "Remove from saved" : "Save"}" title="${saved ? "Saved" : "Save"}">${saved ? BOOKMARK_FILL : BOOKMARK}</button>`;
  }

  /* Source leads every row — she scans sources as she reads. `via` names the
     real outlet behind a query-tracker item; tier-1 primaries get a marker. */
  function srcLabel(item) {
    const name = item.via ? item.via : item.sourceName;
    const t1 = item.tier === 1 ? '<span class="t1-dot" title="Primary document"></span>' : "";
    return `${t1}<span class="src-name">${esc(name)}</span>`;
  }

  function topicChips(tags, max) {
    return (tags || []).slice(0, max || 2).map((t) => esc(window.Fatopics ? Fatopics.label(t) : t)).join(" · ");
  }

  /* Titles lead every card; one quiet meta line sits underneath. */
  function wireRow(item) {
    const rs = App.readStateFor(item.id);
    const cls = rs.readAt ? "read" : (rs.seenAt ? "" : "unread");
    const kind = item.kind ? `<span class="kind">${esc(item.kind)}</span>` : "";
    const rf = App.respondFor(item.id);
    const respFlag = rf && rf.status === "open" ? '<span class="resp-flag">Response wanted</span>' : "";
    const topics = (item.topicTags || []).length ? `<span class="wire-topics">${topicChips(item.topicTags)}</span>` : "";
    return `<div class="wire-row ${cls}" data-region="${esc(item.region || "global")}" data-item="${esc(item.id)}">
      <div class="swipe-under"><span class="u-read">${rs.readAt ? "Unread" : "Read"}</span><span class="u-save">${App.isSaved(item.id) ? "Unsave" : "Save"}</span></div>
      <div class="wire-row-inner" data-action="open-item" data-id="${esc(item.id)}" tabindex="0" role="link">
        <span class="wire-main">
          <div class="wire-title">${esc(item.title)}</div>
          <div class="wire-src">${srcLabel(item)} ${kind} <span class="wire-when">${timeShort(item.published)}</span> ${topics} ${respFlag}</div>
        </span>
        ${saveBtn(item.id, "row")}
      </div>
    </div>`;
  }

  function storySources(story, max) {
    const names = [];
    for (const id of story.itemIds || []) {
      const i = App.itemById(id);
      const n = i ? (i.via || i.sourceName) : null;
      if (n && names.indexOf(n) < 0) names.push(n);
    }
    const shown = names.slice(0, max || 3).map((n) => esc(n)).join(" · ");
    const more = names.length > (max || 3) ? ` +${names.length - (max || 3)}` : "";
    return shown + more;
  }

  function storyCard(story) {
    const unreadCount = story.itemIds.filter((id) => !App.readStateFor(id).readAt).length;
    const region = (story.regions || [])[0] || "global";
    return `<div class="card ${unreadCount ? "unread" : ""}" data-region="${esc(region)}" data-action="open-story" data-id="${esc(story.id)}" tabindex="0" role="link">
      <h3>${esc(story.headline)}</h3>
      ${story.dek ? `<p class="dek">${esc(story.dek)}</p>` : ""}
      <div class="foot"><span class="src-name">${storySources(story)}</span><span>${ago(story.updatedAt)}</span><span>${topicChips(story.topics)}</span>${saveBtn(story.id, "foot-save")}</div>
    </div>`;
  }

  function pinCard(pin, isNew) {
    const cls = pin.priority === "lead" ? "lead" : "";
    const note = pin.note ? `<div class="desk-note"><span class="desk-note-label">From the desk</span>${esc(pin.note)}</div>` : "";
    const deskBtns = App.state.deskMode
      ? `<button class="btn ghost" data-action="edit-pin" data-id="${esc(pin.itemId)}">Edit</button>
         <button class="btn ghost danger" data-action="unpin" data-id="${esc(pin.itemId)}">Unpin</button>` : "";
    return `<div class="card pin-card ${cls}" data-region="${esc(pin.bucket || "global")}" data-action="open-item" data-id="${esc(pin.itemId)}">
      <div class="kicker">
        <span class="pin-tag ${esc(pin.priority || "fyi")}">${esc(cap(pin.priority || "fyi"))}</span>
        ${isNew ? '<span class="pin-tag new">New</span>' : ""}
      </div>
      <h3>${esc(pin.title)}</h3>
      ${note}
      <div class="foot"><span class="src-name">${esc(pin.source || "")}</span>${deskBtns}</div>
    </div>`;
  }

  function cap(s) { return s === "fyi" ? "FYI" : s.charAt(0).toUpperCase() + s.slice(1); }

  /* Relevance: three small bars + a plain label, per person. */
  function relBadge(rel, person) {
    const who = person.surname || person.name;
    const labels = ["Mentions " + who, "Features " + who, "About " + who, "By " + who];
    const bars = [0, 1, 2].map((i) => `<i class="${rel.tier > i ? "on" : ""}"></i>`).join("");
    return `<span class="rel rel-${rel.tier}" title="${esc(rel.label)}"><span class="rel-bars">${bars}</span>${esc(labels[rel.tier])}</span>`;
  }

  /* Verified socials, most-active first. */
  const PLATFORM_LABELS = { x: "X", instagram: "Instagram", facebook: "Facebook", truth: "Truth Social", tiktok: "TikTok", youtube: "YouTube", official: "Official" };
  const ACTIVITY_RANK = { high: 0, medium: 1, low: 2, inactive: 3, none: 4 };

  function socialsRow(person, opts) {
    const socials = (person.socials || []).slice()
      .sort((a, b) => (ACTIVITY_RANK[a.activity] ?? 9) - (ACTIVITY_RANK[b.activity] ?? 9));
    if (!socials.length) return "";
    const max = (opts && opts.max) || 4;
    const chips = socials.slice(0, max).map((s) => {
      const label = PLATFORM_LABELS[s.platform] || s.platform;
      let handle = s.handle.split(" (")[0].trim();
      if (!handle.startsWith("@") && s.platform !== "official" && handle.indexOf(" ") < 0) handle = "@" + handle;
      return `<a class="chip social-chip act-${esc(s.activity)}" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener"
        title="${esc(s.evidence || "")}"><b>${esc(label)}</b> ${esc(handle)}<span class="act-dot"></span></a>`;
    }).join("");
    return `<div class="chips socials">${chips}</div>`;
  }

  /* Portfolio cards: attributed, ranked, quiet. Their words in quotes; the
     channel named; the relevance badge says how much it is about them. */
  function attributionLine(item, person) {
    const who = person.surname || person.name;
    switch (item.kind) {
      case "speech": return who + ", in a speech";
      case "release": return who + ", in a release";
      case "coverage": return esc(item.via || item.sourceName);
      default: {
        const rel = (item.counterparts || []).find((c) => c.id === person.id);
        return rel && rel.rel === "author" ? who : esc(item.via || item.sourceName);
      }
    }
  }

  function personCard(item, person, extraChip) {
    const rs = App.readStateFor(item.id);
    const cls = rs.readAt ? "read" : "unread";
    const rel = App.relevance(item, person);
    const bullets = splitSentences(item.summary || "")
      .filter((s) => normSent(s) !== normSent(item.title))
      .slice(0, 2)
      .map((s) => `<li>${esc(s)}</li>`).join("");
    return `<div class="card cp-item ${cls}" data-region="official" data-item="${esc(item.id)}" data-action="open-item" data-id="${esc(item.id)}" tabindex="0" role="link">
      <div class="claim"><span class="claim-attr">${attributionLine(item, person)}:</span> &ldquo;${esc(item.title)}&rdquo;</div>
      ${bullets ? `<ul class="claim-points">${bullets}</ul>` : ""}
      <div class="foot">${srcLabel(item)} ${extraChip || ""} <span class="k-time">${timeShort(item.published)}</span> <span>${topicChips(item.topicTags)}</span>${(() => { const rf = App.respondFor(item.id); return rf && rf.status === "open" ? '<span class="resp-flag">Response wanted</span>' : ""; })()} ${relBadge(rel, person)}${saveBtn(item.id, "foot-save")}</div>
    </div>`;
  }

  function sortPersonItems(items, person, sort) {
    if (sort === "oldest") return items.slice().sort((a, b) => a.published - b.published);
    if (sort === "newest") return items.slice().sort((a, b) => b.published - a.published);
    // relevance: tier first, then recency
    return items.slice().sort((a, b) =>
      App.relevance(b, person).tier - App.relevance(a, person).tier || b.published - a.published);
  }

  /* ================= views ================= */

  function viewToday() {
    const S = App.state;
    const out = [];

    const pins = App.sortedPins();
    if (pins.length || (S.deskMeta && S.deskMeta.text)) {
      out.push('<div class="section-head">From the desk</div>');
      if (S.deskMeta && S.deskMeta.text) out.push(`<div class="desk-note standalone"><span class="desk-note-label">Today</span>${esc(S.deskMeta.text)}</div>`);
      const newSet = new Set(S.newPinIds || []);
      for (const pin of pins) out.push(pinCard(pin, newSet.has(pin.itemId)));
    }

    const openResp = S.responds.filter((r) => r.status === "open");
    if (openResp.length && S.deskMode) {
      out.push(`<div class="catchup-strip" data-action="nav" data-to="#/deskroom"><span><b>${openResp.length}</b> flagged for response</span><span class="go">Deskroom</span></div>`);
    }

    if (S.catchup && S.catchup.eligible && S.catchup.count > 0) {
      out.push(`<div class="catchup-strip" data-action="nav" data-to="#/catchup">
        <span>Since ${esc(S.catchup.sinceLabel)} — <b>${S.catchup.count} new</b>${S.catchup.pacific ? `, ${S.catchup.pacific} in the Pacific` : ""} · about ${S.catchup.mins} min</span>
        <span class="go">Catch up</span></div>`);
    }

    out.push(`<div class="view-title"><h2>Today</h2><span class="quiet">${esc(dayLabel(Date.now()))}</span></div>
      <div class="seg" data-seg="lens">
        ${[["balanced", "Balanced"], ["pacific", "Pacific first"], ["security", "Security"], ["nz", "NZ angle"]]
          .map(([k, l]) => `<button data-action="lens" data-lens="${k}" class="${S.settings.lens === k ? "active" : ""}">${l}</button>`).join("")}
      </div>`);

    const stories = App.rankedStories();
    if (!stories.list.length && !pins.length) {
      out.push('<div class="empty-state"><div class="big">Nothing on the wire yet</div>Refresh, or check Sources.</div>');
    }
    for (const story of stories.list.slice(0, 24)) out.push(storyCard(story));
    if (stories.muted.length) out.push(`<div class="muted-collapse" data-action="nav" data-to="#/wire?muted=1">${stories.muted.length} in muted topics</div>`);
    out.push('<p style="text-align:center"><button class="btn ghost" data-action="nav" data-to="#/wire">Open the full wire</button></p>');
    return out.join("\n");
  }

  function viewWire(params) {
    const S = App.state;
    const region = params.get("r") || "";
    const topic = params.get("t") || "";
    const q = (params.get("q") || "").toLowerCase();
    const unreadOnly = params.get("u") === "1";
    const showMuted = params.get("muted") === "1";

    const chips = [["", "All"], ["nz", "NZ"], ["official", "Wellington"], ["pacific", "Pacific"], ["global", "Powers"], ["analysis", "Analysis"]]
      .map(([k, l]) => `<button class="chip ${region === k ? "active" : ""}" data-action="wire-region" data-r="${k}">${l}</button>`).join("");

    let items = S.items.filter(App.inScope);
    if (region) items = items.filter((i) => i.region === region);
    if (topic) items = items.filter((i) => (i.topicTags || []).indexOf(topic) >= 0);
    if (unreadOnly) items = items.filter((i) => !App.readStateFor(i.id).readAt);
    if (q) items = items.filter((i) => (i.title + " " + i.summary).toLowerCase().indexOf(q) >= 0);
    if (!showMuted) items = items.filter((i) => !App.isMuted(i));

    const out = [`<div class="view-title"><h2>Wire</h2>
      <span><button class="btn ghost icon" data-action="wire-search" aria-label="Search">${ICON_SEARCH}</button>
      <button class="btn ghost icon" data-action="filter-sheet" aria-label="Filter">${ICON_FILTER}</button></span></div>`];
    out.push(`<div class="chips">${chips}<button class="chip ${unreadOnly ? "active" : ""}" data-action="wire-unread">Unread</button>${topic ? `<button class="chip active" data-action="wire-topic" data-t="">${esc(Fatopics.label(topic))} ✕</button>` : ""}</div>`);
    if (S.uiState.searchOpen || q) {
      out.push(`<input type="text" id="wire-q" placeholder="Search the wire" value="${esc(params.get("q") || "")}" autocomplete="off" style="margin-bottom:10px">`);
    }

    let day = "";
    let shown = 0;
    for (const item of items) {
      if (shown >= 200) break;
      const d = dayLabel(item.published);
      if (d !== day) { day = d; out.push(`<div class="wire-day">${esc(d)}</div>`); }
      out.push(wireRow(item));
      shown++;
    }
    if (!shown) out.push('<div class="empty-state"><div class="big">Nothing matches</div></div>');
    return out.join("\n");
  }

  function viewStory(id) {
    const story = App.storyById(id);
    if (!story) return '<div class="empty-state"><div class="big">Story not found</div>Stories live for the session — open it from Today.</div>';
    const items = story.itemIds.map((iid) => App.itemById(iid)).filter(Boolean)
      .sort((a, b) => b.published - a.published);
    const hlByHash = App.highlightHashesFor("s:" + story.id);
    const first = items.length ? items[items.length - 1].published : story.createdAt;
    const region = (story.regions || [])[0] || "global";

    const body = story.narrative
      ? sentenceSpans(story.narrative, "s:" + story.id, hlByHash)
      : sentenceSpans((items[0] && items[0].summary) || story.dek || "", "s:" + story.id, hlByHash);

    const facts = (story.keyFacts || []).map((f) => `<div class="keyfact"><span>${esc(Cluster.factText(f))}</span></div>`).join("");
    const coverage = items.map((i) => `<div class="coverage-item" data-action="open-item" data-id="${esc(i.id)}">
        <div class="cov-title">${esc(i.title)}</div>
        <div class="m">${srcLabel(i)} · ${timeShort(i.published)} · ${esc(dayLabel(i.published))}</div>
      </div>`).join("");
    const orphans = App.orphanHighlightsFor("s:" + story.id);

    return `<div class="story-head" data-region="${esc(region)}">
      <div class="kicker">${esc(story.topic || "")}</div>
      <h1>${esc(story.headline)}</h1>
      ${story.dek ? `<p class="dek">${esc(story.dek)}</p>` : ""}
      <div class="story-dates">First filed ${esc(dayLabel(first))} · latest ${esc(ago(story.updatedAt))}</div>
      </div>
      ${App.state.uiState.hlArmed ? '<div class="hl-hint">Highlighter on — tap a line to mark it</div>' : ""}
      <div class="story-body ${App.state.uiState.hlArmed ? "hl-armed" : ""}">${body}</div>
      ${facts ? `<div class="section-head">Key facts</div><div class="keyfacts">${facts}</div>` : ""}
      <div class="section-head">Coverage · ${items.length}</div>${coverage}
      ${orphans.length ? `<div class="orphan-hls">From an earlier version: ${orphans.map((h) => `&ldquo;${esc(h.text)}&rdquo;`).join(" · ")}</div>` : ""}
      <div id="explain-pane"></div>
      ${actionBar("story", story.id)}`;
  }

  function viewItem(id) {
    const item = App.itemById(id) || App.savedById(id) || App.pinnedItemStub(id);
    if (!item) return '<div class="empty-state"><div class="big">Item not found</div>It may have aged out of the archive.</div>';
    const hlByHash = App.highlightHashesFor(id);
    const respond = App.respondFor(id);
    const body = `<div class="story-body ${App.state.uiState.hlArmed ? "hl-armed" : ""}">${sentenceSpans(item.summary || item.title, id, hlByHash)}</div>`;
    const note = App.state.notes[id];

    const cpTag = (item.counterparts || [])[0];
    const cp = cpTag ? Sources.counterpart(cpTag.id) : null;
    let contextBlock = "";
    if (cp) {
      const recent = App.counterpartItems(cp.id, "author").filter((i) => i.id !== id).slice(0, 4);
      contextBlock = `<div class="section-head">Context</div>
        <div class="cp-context">
          <p class="dek"><b>${esc(cp.name)}</b> — ${esc(cp.role)}. ${cpTag.rel === "author" ? "This is their own output" : "This is coverage about them"}${item.kind ? ", filed as a " + esc(item.kind) : ""}.</p>
          ${recent.length ? `<div class="ctx-label">Also from ${esc(cp.surname)} this week</div>` +
            recent.map((r) => `<div class="coverage-item" data-action="open-item" data-id="${esc(r.id)}">
              <div class="cov-title">${esc(r.title)}</div>
              <div class="m">${srcLabel(r)} · ${timeShort(r.published)} · ${esc(dayLabel(r.published))}</div></div>`).join("") : ""}
        </div>`;
    }

    let leaderBlock = "";
    const itemLeaders = (item.leaders || []).map((l) => Sources.leader(l)).filter(Boolean);
    if (itemLeaders.length) {
      leaderBlock = `<div class="section-head">Leader files</div><div class="chips">` +
        itemLeaders.map((l) => `<button class="chip" data-action="nav" data-to="#/leader/${esc(l.id)}">${cmark(l)}${esc(l.name)}</button>`).join("") +
        "</div>";
    }

    const related = App.relatedItems(item, 5);
    const relatedBlock = related.length
      ? `<div class="section-head">How the wire is covering it</div>` +
        related.map((r) => `<div class="coverage-item" data-action="open-item" data-id="${esc(r.id)}">
          <div class="cov-title">${esc(r.title)}</div>
          <div class="m">${srcLabel(r)} · ${timeShort(r.published)} · ${esc(dayLabel(r.published))}</div></div>`).join("")
      : "";

    const srcBtn = safeUrl(item.link)
      ? `<a class="btn primary src-btn" href="${esc(item.link)}" target="_blank" rel="noopener">Read at ${esc(item.via || item.sourceName)}</a>`
      : "";

    return `<div class="story-head" data-region="${esc(item.region || "global")}">
      <h1>${esc(item.title)}</h1>
      <div class="byline">${srcLabel(item)} ${item.kind ? `<span class="kind">${esc(item.kind)}</span>` : ""} · ${esc(dayLabel(item.published))} · ${timeShort(item.published)}${item.via ? " · surfaced via " + esc(item.sourceName) : ""}</div>
      </div>
      ${note ? `<div class="desk-note standalone"><span class="desk-note-label">From the desk</span>${esc(note.text)}</div>` : ""}
      ${respond ? respondStatus(respond) : ""}
      ${App.state.uiState.hlArmed ? '<div class="hl-hint">Highlighter on — tap a line to mark it</div>' : ""}
      ${body}
      ${srcBtn ? `<p class="src-btn-row">${srcBtn}</p>` : ""}
      ${contextBlock}
      ${leaderBlock}
      ${relatedBlock}
      <div id="explain-pane"></div>
      ${actionBar("item", id)}`;
  }

  function actionBar(scope, id) {
    const S = App.state;
    const saved = App.isSaved(id);
    const hl = S.uiState.hlArmed;
    // Flags attach to ITEMS: on a story page the flag rides the lead item,
    // and a story with no members yet gets no flag button at all.
    const flagId = scope === "story" ? (((App.storyById(id) || {}).itemIds || [])[0] || "") : id;
    const flag = flagId ? App.respondFor(flagId) : null;
    const flagLabel = flag ? (flag.status === "done" ? "Responded" : "Flagged") : "Flag";
    const deskBits = S.deskMode
      ? `<button data-action="pin-sheet" data-id="${esc(id)}" data-scope="${scope}">Pin</button>
         ${flagId ? `<button data-action="respond-flag" data-id="${esc(flagId)}" class="${flag && flag.status === "open" ? "on amber" : ""}">${flagLabel}</button>` : ""}` : "";
    return `<div class="actionbar">
      <button data-action="toggle-save" data-id="${esc(id)}" class="${saved ? "on amber" : ""}">${saved ? "Saved" : "Save"}</button>
      <button data-action="toggle-hl" class="${hl ? "on amber" : ""}">Mark</button>
      <button data-action="explain" data-id="${esc(id)}" data-scope="${scope}">Explain</button>
      <button data-action="font-cycle">Aa</button>
      ${deskBits}
    </div>`;
  }

  /* The flag as a real object on the item page: who it answers, when it was
     raised, the desk's note, and — once answered — the response itself. */
  function respondStatus(flag) {
    const done = flag.status === "done";
    const cp = flag.counterpartId ? Sources.counterpart(flag.counterpartId) : null;
    const meta = [
      cp ? "answers " + cp.surname : "",
      "flagged " + ago(flag.flaggedAt),
      done && flag.respondedAt ? "responded " + ago(flag.respondedAt) : "",
    ].filter(Boolean).join(" · ");
    const deskBits = App.state.deskMode
      ? `<div class="flag-actions">${done
          ? `<button class="btn ghost danger" data-action="respond-clear" data-id="${esc(flag.itemId)}">Clear from the record</button>`
          : `<button class="btn" data-action="respond-done" data-id="${esc(flag.itemId)}">Mark responded</button>
             <button class="btn ghost danger" data-action="respond-clear" data-id="${esc(flag.itemId)}">Clear flag</button>`}</div>`
      : "";
    return `<div class="flag-status ${done ? "done" : ""}">
      <span class="flag-status-label">${done ? "Responded" : "Flagged for response"}</span>
      <span class="flag-status-meta">${esc(meta)}</span>
      ${flag.note ? `<div class="flag-note">&ldquo;${esc(flag.note)}&rdquo;</div>` : ""}
      ${done && safeUrl(flag.respondedUrl) ? `<a class="flag-response-link" href="${esc(flag.respondedUrl)}" target="_blank" rel="noopener">Read the response</a>` : ""}
      ${deskBits}
    </div>`;
  }

  /* ---- The Desk: the dated page the comms team ships to Vanushi. One
     renderer for her page AND the composer preview, so what the desk sees
     before shipping is exactly what she gets. ---- */
  /* Allowlist sanitiser for desk-page HTML: the page ships through the
     relay and renders on her phone, so only document furniture survives —
     no scripts, no handlers, no styles, links limited to https and in-app. */
  function sanitizeHtml(html) {
    const ALLOWED = { P: 1, H2: 1, H3: 1, UL: 1, OL: 1, LI: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, A: 1, BLOCKQUOTE: 1, DIV: 1, HR: 1, BR: 1, SPAN: 1, CODE: 1, TABLE: 1, TBODY: 1, TR: 1, TD: 1 };
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html || "");
    const clean = (parent) => {
      for (const el of [...parent.children]) {
        if (!ALLOWED[el.tagName]) {
          const kids = [...el.childNodes];
          el.replaceWith(...kids);
          for (const k of kids) if (k.nodeType === 1) clean(k.parentNode || parent);
          continue;
        }
        for (const attr of [...el.attributes]) {
          const n = attr.name.toLowerCase();
          if (el.tagName === "A" && n === "href" && /^(https?:\/\/|#\/)/i.test(attr.value)) continue;
          if ((el.tagName === "DIV" || el.tagName === "SPAN") && n === "class" && attr.value === "callout") continue;
          el.removeAttribute(attr.name);
        }
        if (el.tagName === "A") {
          el.setAttribute("rel", "noopener");
          if (/^https?:/i.test(el.getAttribute("href") || "")) el.setAttribute("target", "_blank");
        }
        clean(el);
      }
    };
    clean(tpl.content);
    return tpl.innerHTML;
  }

  function deskBodyHtml(page) {
    if (page && page.html) return sanitizeHtml(page.html);
    if (page && page.md) return md(page.md);
    return "";
  }

  function deskPageHtml(page) {
    const body = deskBodyHtml(page);
    if (!body) {
      return `<div class="empty-state"><div class="big">Nothing on the desk yet</div>Today's page will appear here when it's ready.</div>`;
    }
    const dateLong = page.dateLong || page.date || "";
    return `<article class="desk-page">
      <header>
        <div class="desk-page-rule"></div>
        <h1>The Desk</h1>
        <div class="desk-page-date">${esc(dateLong)}</div>
      </header>
      <div class="md desk-page-body">${body}</div>
      ${page.shippedAt ? `<footer class="desk-page-foot">Prepared by the desk · ${esc(timeShort(page.shippedAt))}</footer>` : ""}
    </article>`;
  }

  function viewDesk() {
    const S = App.state;
    const out = [deskPageHtml(S.deskPage)];
    if (S.deskMode) {
      out.push(`<p style="text-align:center;margin-top:18px"><button class="btn" data-action="nav" data-to="#/deskroom">Open the deskroom</button></p>`);
    }
    return out.join("\n");
  }

  function viewDeskroom() {
    const S = App.state;
    if (!S.deskMode) return '<div class="empty-state"><div class="big">Deskroom is locked</div>Unlock desk mode in Settings with the desk key.</div>';
    const d = S.uiState.deskDraft;
    const out = [`<div class="view-title"><h2>Deskroom</h2></div>`];

    // --- today's page composer ---
    const shipped = S.deskPage && S.deskPage.date === (d && d.date) && S.deskPage.html === (d && d.html);
    const status = !d ? "Preparing…"
      : d.running ? "Drafting…"
      : `Draft for ${esc(dayLabel(Date.parse(d.date + "T12:00:00+12:00")))}${d.source === "edited" ? " · edited" : ""}${shipped ? " · shipped" : ""}`;
    out.push(`<div class="deskroom-bar">
      <span class="status">${status}</span>
      <span class="deskroom-actions">
        <button class="btn" data-action="desk-regenerate" ${d && d.running ? "disabled" : ""}>Redraft</button>
        <button class="btn primary" data-action="desk-ship" ${d && d.running ? "disabled" : ""}>Ship</button>
      </span>
    </div>`);
    out.push(`<div class="desk-toolbar">
      <button class="btn ghost" data-action="desk-insert-sheet">+ Article</button>
      <button class="btn ghost" data-action="desk-snippet" data-snip="heading">Section</button>
      <button class="btn ghost" data-action="desk-snippet" data-snip="callout">Callout</button>
      <button class="btn ghost" data-action="desk-snippet" data-snip="quote">Quote</button>
      <button class="btn ghost" data-action="desk-snippet" data-snip="divider">Divider</button>
      <span class="desk-toolbar-more">
        <button class="btn ghost" data-action="desk-snippet" data-snip="read">Read these</button>
        <button class="btn ghost" data-action="desk-snippet" data-snip="running">Running stories</button>
        <button class="btn ghost" data-action="desk-snippet" data-snip="coming">Coming up</button>
      </span>
    </div>`);
    // The editor IS the page: same article chrome, fixed title and date the
    // desk cannot edit, and a body edited in place — what you type is
    // literally what ships.
    out.push(`<article class="desk-page desk-page-editing">
      <header>
        <div class="desk-page-rule"></div>
        <h1>The Desk</h1>
        <div class="desk-page-date">${esc(App.todayNZLong())}</div>
      </header>
      <div class="md desk-page-body desk-editor-rich" id="desk-md" contenteditable="${d && d.running ? "false" : "true"}" spellcheck="true">${deskBodyHtml({ html: d ? d.html : "" })}</div>
    </article>`);

    // --- desk tools ---
    const pins = App.sortedPins();
    out.push('<div class="section-head">Today line</div>');
    out.push(`<textarea id="desk-meta" maxlength="280" placeholder="One line for the top of Today">${esc((S.deskMeta && S.deskMeta.text) || "")}</textarea>
      <p><button class="btn" data-action="save-desk-meta">Set</button>
      ${S.deskMeta && S.deskMeta.text ? '<button class="btn ghost danger" data-action="clear-desk-meta">Clear</button>' : ""}</p>`);

    out.push(`<div class="section-head">Pins · ${pins.length}</div>`);
    if (!pins.length) out.push('<p class="quiet">Nothing pinned. Pin from any story.</p>');
    for (const pin of pins) {
      const left = pin.expiresAt ? Math.max(0, Math.round((pin.expiresAt - Date.now()) / 3600000)) : null;
      out.push(`<div class="card pin-card ${pin.priority === "lead" ? "lead" : ""}">
        <div class="kicker"><span class="pin-tag ${esc(pin.priority)}">${esc(cap(pin.priority))}</span>
          ${left !== null ? `<span>expires in ${left < 48 ? left + " h" : Math.round(left / 24) + " d"}</span>` : ""}</div>
        <h3 data-action="open-item" data-id="${esc(pin.itemId)}">${esc(pin.title)}</h3>
        ${pin.note ? `<div class="desk-note"><span class="desk-note-label">Steer</span>${esc(pin.note)}</div>` : ""}
        <div class="foot"><button class="btn ghost" data-action="edit-pin" data-id="${esc(pin.itemId)}">Edit</button>
        <button class="btn ghost danger" data-action="unpin" data-id="${esc(pin.itemId)}">Unpin</button></div></div>`);
    }

    const openResp = S.responds.filter((r) => r.status === "open").sort((a, b) => a.flaggedAt - b.flaggedAt);
    const doneResp = S.responds.filter((r) => r.status === "done").slice(0, 10);
    out.push(`<div class="section-head">Response queue · ${openResp.length} open</div>`);
    if (!openResp.length) out.push('<p class="quiet">No open flags.</p>');
    for (const r of openResp) {
      const cp = Sources.counterpart(r.counterpartId);
      out.push(`<div class="card" data-region="official">
        <div class="kicker"><span class="resp-flag">${esc(cp ? cp.surname : "Flagged")}</span><span>flagged ${ago(r.flaggedAt)}</span></div>
        <h3 data-action="open-item" data-id="${esc(r.itemId)}">${esc(r.title)}</h3>
        ${r.note ? `<p class="dek">${esc(r.note)}</p>` : ""}
        <div class="foot"><button class="btn" data-action="respond-done" data-id="${esc(r.itemId)}">Mark responded</button>
        <button class="btn ghost danger" data-action="respond-clear" data-id="${esc(r.itemId)}">Clear</button></div></div>`);
    }
    if (doneResp.length) {
      out.push('<div class="section-head">Recently responded</div>');
      for (const r of doneResp) {
        out.push(`<div class="src-row"><div class="top"><b>${esc(r.title)}</b></div>
          <div class="meta">responded ${ago(r.respondedAt)} ${safeUrl(r.respondedUrl) ? `· <a href="${esc(r.respondedUrl)}" target="_blank" rel="noopener">the response</a>` : ""}</div></div>`);
      }
    }

    out.push(`<div class="section-head">Reading pack</div>
      <p class="quiet">Reading packs shared from the app land here — review the highlights with deep links.</p>
      <p><button class="btn" data-action="import-pack">Choose file</button></p>
      <div id="pack-review">${S.uiState.packReview || ""}</div>`);

    const history = (S.uiState.deskHistory || []).filter((b) => !d || b.date !== d.date || b.md !== d.md);
    if (history.length) {
      out.push(`<div class="section-head">Past desks · ${history.length}</div>`);
      for (const b of history.slice(0, 10)) {
        out.push(`<div class="src-row"><div class="top"><b>The Desk — ${esc(b.date)}</b>
          <span><button class="btn ghost" data-action="desk-history-view" data-id="${esc(b.id)}">View</button>
          <button class="btn ghost" data-action="desk-history-reuse" data-id="${esc(b.id)}">Reuse</button></span></div>
          <div class="meta">shipped ${esc(timeShort(b.shippedAt))} · ${esc(dayLabel(b.shippedAt))}</div></div>`);
      }
    }

    out.push(`<div class="section-head">Relay</div>
      <p class="quiet">${Relay.enabled() ? `Connected · last sync ${ago(S.relaySyncedAt)}` : "Not configured — set the relay URL and keys in Settings."}</p>`);
    return out.join("\n");
  }

  function viewBrief() {
    const S = App.state;
    const b = S.uiState.brief || {};
    return `<div class="view-title"><h2>Brief</h2>
        <button class="btn primary" data-action="run-brief">${b.running ? "Writing…" : "Compile"}</button></div>
      ${b.ai || b.running ? `<div class="section-head">Morning brief</div><div class="md" id="brief-ai">${md(b.ai || "")}${b.running ? '<span class="stream-cursor"></span>' : ""}</div>` : ""}
      ${b.local ? `<div class="section-head">From the wire</div><div class="md">${md(b.local)}</div>` : '<div class="empty-state">Compile today\'s brief from the archive.</div>'}
      ${b.error ? `<p class="quiet" style="color:var(--red)">${esc(b.error)}</p>` : ""}`;
  }

  function viewSaved() {
    const saved = App.state.saved.slice().sort((a, b) => b.savedAt - a.savedAt);
    const hls = App.state.highlights.slice().sort((a, b) => b.at - a.at);
    const tab = App.state.uiState.savedTab || "saved";
    const out = [`<div class="view-title"><h2>Saved</h2>
      <button class="btn" data-action="share-pack">Share pack</button></div>
      <div class="seg"><button data-action="saved-tab" data-t="saved" class="${tab === "saved" ? "active" : ""}">Saved · ${saved.length}</button>
      <button data-action="saved-tab" data-t="hl" class="${tab === "hl" ? "active" : ""}">Highlights · ${hls.length}</button></div>`];
    if (tab === "saved") {
      if (!saved.length) out.push('<div class="empty-state"><div class="big">Nothing saved yet</div>Tap the bookmark on any story.</div>');
      for (const s of saved) {
        out.push(`<div class="card" data-region="${esc(s.region || "global")}" data-action="open-item" data-id="${esc(s.id)}">
          <div class="kicker"><span class="src-name">${esc(s.sourceName || "")}</span><span>saved ${ago(s.savedAt)}</span></div>
          <h3>${esc(s.title)}</h3>
          <div class="foot"><button class="btn ghost danger" data-action="unsave" data-id="${esc(s.id)}">Remove</button></div></div>`);
      }
    } else {
      if (!hls.length) out.push('<div class="empty-state"><div class="big">No highlights yet</div>Open a story, tap Mark, tap a line.</div>');
      for (const h of hls) {
        out.push(`<div class="card" data-action="open-item" data-id="${esc(h.refId.replace(/^s:/, ""))}">
          <div class="kicker"><span class="src-name">${esc((h.context && h.context.source) || "")}</span><span>${ago(h.at)}</span></div>
          <p class="dek">&ldquo;${esc(h.text)}&rdquo;</p>
          <div class="foot"><span>${esc((h.context && h.context.title) || "")}</span>
          <button class="btn ghost danger" data-action="del-hl" data-id="${esc(h.id)}">Remove</button></div></div>`);
      }
    }
    return out.join("\n");
  }

  function viewCatchup() {
    const S = App.state;
    const since = S.catchup ? S.catchup.since : Date.now() - 86400000;
    const items = S.items.filter((i) => i.published > since && !App.readStateFor(i.id).readAt && !App.isMuted(i) && App.inScope(i))
      .sort((a, b) => a.published - b.published);
    const words = items.reduce((n, i) => n + (i.title + " " + i.summary).split(/\s+/).length, 0);
    const out = [`<div class="view-title"><h2>Catch-up</h2>
      <button class="btn" data-action="mark-all-read">Mark all read</button></div>`];
    let day = "";
    for (const item of items) {
      const d = dayLabel(item.published);
      if (d !== day) { day = d; out.push(`<div class="wire-day">${esc(d)}</div>`); }
      out.push(wireRow(item));
    }
    if (!items.length) out.push('<div class="empty-state"><div class="big">All caught up</div></div>');
    else out.push(`<p class="quiet" style="text-align:center;margin-top:14px">${items.length} left · about ${Math.max(1, Math.round(words / 220))} min</p>`);
    return out.join("\n");
  }

  function viewPortfolio() {
    const S = App.state;
    const cps = Sources.counterparts().filter((c) => !c.defaultOff || (S.settings.counterpartsOn || {})[c.id]);
    const out = [`<div class="view-title"><h2>Portfolio</h2></div>`];
    if (Sources.reviewDue()) {
      out.push(`<div class="hl-hint">Re-verification due — holders change after the ${esc(Sources.reviewBy())} election.</div>`);
    }
    out.push('<div class="section-head">Ministers</div>');
    if (!cps.length) out.push('<p class="quiet">No counterparts enabled — turn them on in Sources.</p>');
    for (const cp of cps) {
      const authored = App.counterpartItems(cp.id, "author");
      const last = authored[0];
      const spark = window.Charts ? Charts.spark(App.counterpartDaily(cp.id), { w: 90, h: 26 }) : "";
      const openResp = S.responds.filter((r) => r.status === "open" && r.counterpartId === cp.id).length;
      out.push(`<div class="cp-card" style="border-left-color:${esc(cp.colour || "#888")}" data-action="nav" data-to="#/portfolio/${esc(cp.id)}">
        <div class="cp-main">
          <h3>${esc(cp.name)}</h3>
          <div class="role">${esc(cp.role)}</div>
          <div class="last">${last ? "Last output " + ago(last.published) + (last.kind ? " — " + esc(last.kind) : "") : "Quiet in the current window"}</div>
          ${last ? `<div class="latest-line">${esc(last.title.slice(0, 90))}</div>` : ""}
        </div>
        ${openResp ? `<span class="resp-badge">${openResp}</span>` : ""}
        <span class="spark">${spark}</span>
      </div>`);
    }

    const lds = Sources.leaders();
    if (lds.length) {
      out.push('<div class="section-head">World leaders</div>');
      for (const ld of lds) {
        const counts = App.leaderScopeCounts(ld.id);
        const total = counts.globe + counts.country + counts.self;
        const last = App.leaderItems(ld.id)[0];
        const spark = window.Charts ? Charts.spark(App.leaderDaily(ld.id), { w: 90, h: 26 }) : "";
        out.push(`<div class="cp-card" style="border-left-color:${esc(ld.colour || "#888")}" data-action="nav" data-to="#/leader/${esc(ld.id)}">
          <div class="cp-main">
            <h3>${cmark(ld)}${esc(ld.name)}</h3>
            <div class="role">${esc(ld.role)} · ${esc(ld.country)}</div>
            <div class="last">${total ? `${total} this window — <span class="sc-globe">${counts.globe} globe</span> · <span class="sc-country">${counts.country} home</span> · <span class="sc-self">${counts.self} self</span>` : "Quiet in the current window"}</div>
            ${last ? `<div class="latest-line">${esc(last.title.slice(0, 90))}</div>` : ""}
          </div>
          <span class="spark">${spark}</span>
        </div>`);
      }
    }
    return out.join("\n");
  }

  function viewCounterpart(id) {
    const cp = Sources.counterpart(id);
    if (!cp) return '<div class="empty-state"><div class="big">Unknown counterpart</div></div>';
    const ui = App.state.uiState;

    const direct = App.counterpartItems(id, "author");
    const directIds = new Set(direct.map((i) => i.id));
    const coverage = App.coverageItems(cp).filter((i) => !directIds.has(i.id));

    // Direct by default; an empty direct file falls through to coverage with
    // a note rather than a dead end (the PM has no "own output" feed here,
    // but there is always news about him).
    let mode = ui.cpCoverage ? "coverage" : "direct";
    let fellThrough = false;
    if (mode === "direct" && !direct.length && coverage.length) { mode = "coverage"; fellThrough = true; }

    let items = mode === "direct" ? direct : coverage;
    const type = ui.cpType || "";
    if (mode === "direct" && type) items = items.filter((i) => (i.kind || "") === type);
    const q = (ui.cpQuery || "").toLowerCase();
    if (q) items = items.filter((i) => (i.title + " " + (i.summary || "") + " " + (i.via || i.sourceName)).toLowerCase().indexOf(q) >= 0);
    const sort = ui.cpSort === "newest" ? "newest" : "relevance";
    items = sortPersonItems(items, cp, sort);

    const typeChips = mode === "direct"
      ? [["", "All"], ["release", "Releases"], ["speech", "Speeches"]]
          .map(([k, l]) => `<button class="chip ${type === k ? "active" : ""}" data-action="cp-type" data-t="${k}">${l}</button>`).join("")
      : "";

    const out = [`<div class="view-title"><h2>${esc(cp.name)}</h2></div>
      <p class="role-line">${esc(cp.role)}</p>
      ${socialsRow(cp)}
      <div class="chips">
        <button class="chip ${mode === "direct" ? "active" : ""}" data-action="cp-authored">Direct · ${direct.length}</button>
        <button class="chip ${mode === "coverage" ? "active" : ""}" data-action="cp-coverage">Coverage · ${coverage.length}</button>
        ${typeChips ? `<span class="chip-gap"></span>${typeChips}` : ""}
      </div>
      <div class="cp-tools">
        <div class="seg">${[["relevance", "Most relevant"], ["newest", "Newest"]]
          .map(([k, l]) => `<button data-action="cp-sort" data-s="${k}" class="${sort === k ? "active" : ""}">${l}</button>`).join("")}</div>
        <input type="text" id="cp-q" placeholder="Search this file" value="${esc(ui.cpQuery || "")}" autocomplete="off">
      </div>`];
    if (fellThrough) out.push('<p class="quiet">No direct output in the current window — showing coverage.</p>');

    let day = "";
    for (const item of items.slice(0, 120)) {
      if (sort === "newest") {
        const d = dayLabel(item.published);
        if (d !== day) { day = d; out.push(`<div class="wire-day">${esc(d)}</div>`); }
      }
      out.push(personCard(item, cp));
    }
    if (!items.length) out.push('<div class="empty-state"><div class="big">Nothing matches</div></div>');
    return out.join("\n");
  }

  function viewLeader(id) {
    const ld = Sources.leader(id);
    if (!ld) return '<div class="empty-state"><div class="big">Unknown leader</div></div>';
    const ui = App.state.uiState;
    const scope = ui.ldScope || "";
    // Union of poller-tagged leader items and the client relevance scan, so
    // the file is never thinner than what the wire actually holds.
    const tagged = App.leaderItems(id, scope || null);
    const ids = new Set(tagged.map((i) => i.id));
    let items = scope ? tagged
      : tagged.concat(App.coverageItems(ld).filter((i) => !ids.has(i.id)));
    const q = (ui.ldQuery || "").toLowerCase();
    if (q) items = items.filter((i) => (i.title + " " + (i.summary || "") + " " + (i.via || i.sourceName)).toLowerCase().indexOf(q) >= 0);
    const sort = ui.ldSort === "newest" ? "newest" : "relevance";
    items = sortPersonItems(items, ld, sort);

    const counts = App.leaderScopeCounts(id);
    const scopeChips = [["", `All · ${counts.globe + counts.country + counts.self}`],
      ["globe", `The globe · ${counts.globe}`], ["country", `${esc(ld.country)} · ${counts.country}`], ["self", `Themselves · ${counts.self}`]]
      .map(([k, l]) => `<button class="chip sc-chip-${k || "all"} ${scope === k ? "active" : ""}" data-action="ld-scope" data-s="${k}">${l}</button>`).join("");

    const out = [`<div class="view-title"><h2>${cmark(ld, true)}${esc(ld.name)}</h2></div>
      <p class="role-line">${esc(ld.role)}, ${esc(ld.country)}</p>
      ${socialsRow(ld)}
      <div class="chips">${scopeChips}</div>
      <div class="cp-tools">
        <div class="seg">${[["relevance", "Most relevant"], ["newest", "Newest"]]
          .map(([k, l]) => `<button data-action="ld-sort" data-s="${k}" class="${sort === k ? "active" : ""}">${l}</button>`).join("")}</div>
        <input type="text" id="ld-q" placeholder="Search this file" value="${esc(ui.ldQuery || "")}" autocomplete="off">
      </div>`];

    let day = "";
    for (const item of items.slice(0, 120)) {
      if (sort === "newest") {
        const d = dayLabel(item.published);
        if (d !== day) { day = d; out.push(`<div class="wire-day">${esc(d)}</div>`); }
      }
      const scopeChip = item.scope
        ? `<span class="kind sc-${esc(item.scope)}">${esc(item.scope === "self" ? "themselves" : item.scope === "globe" ? "globe" : "home")}</span>` : "";
      out.push(personCard(item, ld, scopeChip));
    }
    if (!items.length) out.push('<div class="empty-state"><div class="big">Nothing matches</div></div>');
    return out.join("\n");
  }

  function viewSearch() {
    const q = (App.state.uiState.gq || "").trim().toLowerCase();
    const out = [`<div class="view-title"><h2>Search</h2></div>
      <input type="text" id="global-q" placeholder="Search everything" value="${esc(App.state.uiState.gq || "")}" autocomplete="off" autofocus style="margin-bottom:14px">`];
    if (q.length < 2) {
      return out.join("\n");
    }
    const hit = (s) => String(s || "").toLowerCase().indexOf(q) >= 0;
    const items = App.state.items.filter((i) => hit(i.title) || hit(i.summary) || hit(i.via || i.sourceName)).slice(0, 40);
    const saved = App.state.saved.filter((s) => hit(s.title) || hit(s.summary));
    const hls = App.state.highlights.filter((h) => hit(h.text) || hit(h.context && h.context.title));
    const desks = (App.state.uiState.deskHistory || []).filter((b) => hit((b.html || b.md || "").replace(/<[^>]+>/g, " ")));
    if (items.length) {
      out.push(`<div class="section-head">On the wire · ${items.length}</div>`);
      for (const i of items) out.push(wireRow(i));
    }
    if (saved.length) {
      out.push(`<div class="section-head">Saved · ${saved.length}</div>`);
      for (const s of saved) out.push(`<div class="coverage-item" data-action="open-item" data-id="${esc(s.id)}">
        <div class="cov-title">${esc(s.title)}</div><div class="m"><span class="src-name">${esc(s.sourceName || "")}</span></div></div>`);
    }
    if (hls.length) {
      out.push(`<div class="section-head">Highlights · ${hls.length}</div>`);
      for (const h of hls) out.push(`<div class="coverage-item" data-action="open-item" data-id="${esc(h.refId.replace(/^s:/, ""))}">
        <div>&ldquo;${esc(h.text)}&rdquo;</div><div class="m">${esc((h.context && h.context.title) || "")}</div></div>`);
    }
    if (App.state.deskMode && desks.length) {
      out.push(`<div class="section-head">Past desks · ${desks.length}</div>`);
      for (const b of desks) out.push(`<div class="coverage-item" data-action="desk-history-view" data-id="${esc(b.id)}">
        <div>The Desk — ${esc(b.date)}</div></div>`);
    }
    if (!items.length && !saved.length && !hls.length && !desks.length) out.push('<div class="empty-state"><div class="big">Nothing matches</div></div>');
    return out.join("\n");
  }

  function viewSources() {
    const S = App.state;
    const meta = Corpus.lastMeta || {};
    const healthBy = {};
    for (const h of meta.sources || []) healthBy[h.id] = h;
    const groups = {};
    for (const src of Sources.all(S.settings)) (groups[src.stream] = groups[src.stream] || []).push(src);
    const out = [`<div class="view-title"><h2>Sources</h2></div>
      <p class="quiet">Registry verified ${esc(Sources.registryVerified())}. Toggles persist on this device.</p>`];
    for (const stream of Object.keys(groups)) {
      out.push(`<div class="section-head">${esc((Sources.meta(groups[stream][0]) || {}).streamNote || stream)}</div>`);
      for (const src of groups[stream]) {
        const on = Sources.enabled(src, S.settings);
        const h = healthBy[src.id];
        const health = h ? (h.ok ? `ok · ${h.itemCount} items` : `down: ${esc(h.error || "")}`) : "";
        out.push(`<div class="src-row"><div class="top"><b><span class="tier-dot tier-${src.tier}"></span>${esc(src.name)}</b>
          <label class="toggle"><input type="checkbox" data-action="src-toggle" data-id="${esc(src.id)}" ${on ? "checked" : ""}><span class="tr"></span></label></div>
          <div class="note">${esc(Sources.meta(src).note)}</div>
          <div class="meta">${health}</div></div>`);
      }
    }
    return out.join("\n");
  }

  function viewSettings() {
    const S = App.state.settings;
    const gateMode = (window.Gate && Gate.mode()) || "1h";
    return `<div class="view-title"><h2>Settings</h2></div>

    <div class="set-block"><div class="section-head">Reading</div>
      <div class="set-row"><div class="l"><b>Theme</b></div>
        <div class="seg">${[["", "System"], ["dark", "Night"], ["light", "Day"]].map(([k, l]) => `<button data-action="set-theme" data-v="${k}" class="${(S.theme || "") === k ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="set-row"><div class="l"><b>Text size</b></div>
        <div class="seg">${[[0.9, "S"], [1, "M"], [1.1, "L"], [1.25, "XL"]].map(([k, l]) => `<button data-action="set-font" data-v="${k}" class="${S.fontScale === k ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="set-row"><div class="l"><b>Default lens</b></div>
        <div class="seg">${[["balanced", "Balanced"], ["pacific", "Pacific"], ["security", "Security"], ["nz", "NZ"]].map(([k, l]) => `<button data-action="set-lens-default" data-v="${k}" class="${S.lens === k ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="set-row"><div class="l"><b>Require PIN</b><span>A privacy screen for this device, not account security.</span></div>
        <div class="seg">${[["open", "Every open"], ["1h", "After 1 h"], ["24h", "After 24 h"]].map(([k, l]) => `<button data-action="set-gate" data-v="${k}" class="${gateMode === k ? "active" : ""}">${l}</button>`).join("")}</div></div>
      <div class="set-row"><div class="l"><b>Muted topics</b><span>${(S.muted.topics || []).map((t) => esc(Fatopics.label(t))).join(", ") || "None"}</span></div>
        ${(S.muted.topics || []).length ? '<button class="btn ghost" data-action="clear-mutes">Clear</button>' : ""}</div>
    </div>

    <div class="set-block"><div class="section-head">Data</div>
      <div class="set-row"><div class="l"><b>News updates</b><span>${esc(Corpus.freshness().label)} · refreshes every ${S.refreshMins} min while open</span></div>
        <button class="btn" data-action="sweep-now">Refresh</button></div>
      <div class="set-row"><div class="l"><b>Direct feed poll</b><span>Runs automatically if updates fall behind.</span></div>
        <button class="btn" data-action="live-boost">Run now</button></div>
      <div class="set-row"><div class="l"><b>Clock</b><span>${(() => {
        const ck = window.Clock ? Clock.status() : null;
        return ck && ck.synced
          ? esc(`Synced via ${ck.source} — accurate to ±${ck.uncertainty} ms`)
          : "Using the device clock — no time server reachable.";
      })()}</span></div>
        <button class="btn" data-action="clock-resync">Sync now</button></div>
      <div class="set-row"><div class="l"><b>Archive</b><span>Keys never travel in either direction.</span></div>
        <span><button class="btn" data-action="export-archive">Export</button>
        <button class="btn" data-action="import-archive">Import</button></span></div>
    </div>

    <div class="set-block"><div class="section-head">Connections</div>
      <label class="f">Anthropic API key</label>
      <input type="password" id="set-apikey" autocomplete="off" placeholder="sk-ant-…" value="${esc(S.apiKey || "")}">
      <label class="f">Relay URL</label>
      <input type="url" id="set-relayurl" autocomplete="off" placeholder="https://…workers.dev" value="${esc(S.relayUrl || "")}">
      <label class="f">Reader key</label>
      <input type="password" id="set-relaykey" autocomplete="off" value="${esc(S.relayKey || "")}">
    </div>

    <div class="set-block"><div class="section-head">Desk</div>
      ${App.state.deskMode
        ? `<div class="set-row"><div class="l"><b>Desk mode is on for this session</b><span>The key is never stored — closing the app locks the desk again.</span></div>
           <button class="btn danger" data-action="desk-lock">Lock now</button></div>`
        : `<label class="f">Desk key</label>
           <input type="password" id="set-deskkey" autocomplete="off">
           <p class="form-hint">Unlocks the desk for this session only. The key is never saved on the device.</p>
           <button class="btn primary" style="margin-top:10px" data-action="desk-unlock">Unlock desk mode</button>`}
    </div>

    <div class="set-block"><div class="section-head">About</div>
      <p class="quiet">InterDesk · Vanushi Walters · registry verified ${esc(Sources.registryVerified())}. Full re-verification due after the 7 November 2026 election. If a device is lost, rotate the relay keys first.</p>
    </div>`;
  }

  /* ================= router + chrome ================= */

  const ROUTES = [
    { re: /^#\/?$/, view: () => viewToday(), tab: "#/" },
    { re: /^#\/wire/, view: (m, p) => viewWire(p), tab: "#/wire" },
    { re: /^#\/story\/(.+)$/, view: (m) => viewStory(m[1]), tab: "#/" },
    { re: /^#\/item\/(.+)$/, view: (m) => viewItem(m[1]), tab: "#/" },
    { re: /^#\/deskroom/, view: () => viewDeskroom(), tab: "more" },
    { re: /^#\/desk/, view: () => viewDesk(), tab: "#/desk" },
    { re: /^#\/brief/, view: () => viewBrief(), tab: "more" },
    { re: /^#\/saved/, view: () => viewSaved(), tab: "more" },
    { re: /^#\/catchup/, view: () => viewCatchup(), tab: "#/" },
    { re: /^#\/portfolio\/(.+)$/, view: (m) => viewCounterpart(m[1]), tab: "#/portfolio" },
    { re: /^#\/portfolio/, view: () => viewPortfolio(), tab: "#/portfolio" },
    { re: /^#\/leader\/(.+)$/, view: (m) => viewLeader(m[1]), tab: "#/portfolio" },
    { re: /^#\/search/, view: () => viewSearch(), tab: "more" },
    { re: /^#\/sources/, view: () => viewSources(), tab: "more" },
    { re: /^#\/settings/, view: () => viewSettings(), tab: "more" },
  ];

  const NAV = [
    ["#/", "Today"], ["#/wire", "Wire"], ["#/desk", "Desk"], ["#/portfolio", "Portfolio"],
    ["#/brief", "Brief"], ["#/saved", "Saved"], ["#/search", "Search"], ["#/sources", "Sources"], ["#/deskroom", "Deskroom"], ["#/settings", "Settings"],
  ];
  const TABS = [
    ["#/", "Today"], ["#/wire", "Wire"], ["#/desk", "Desk"], ["#/portfolio", "Portfolio"], ["more", "More"],
  ];

  function parseHash() {
    const hash = location.hash || "#/";
    const qIdx = hash.indexOf("?");
    const path = qIdx >= 0 ? hash.slice(0, qIdx) : hash;
    const params = new URLSearchParams(qIdx >= 0 ? hash.slice(qIdx + 1) : "");
    return { path, params, hash };
  }

  const UI = {
    md, esc, timeShort, dayLabel, ago, sentHash, splitSentences, fnv, deskPageHtml, sanitizeHtml, deskBodyHtml,

    render() {
      const { path, params } = parseHash();
      const main = document.getElementById("main");
      const keep = {};
      for (const el of main.querySelectorAll("input[id], textarea[id]")) keep[el.id] = el.value;
      const focused = document.activeElement && document.activeElement.id;

      let html = "";
      let activeTab = "#/";
      try {
        for (const r of ROUTES) {
          const m = path.match(r.re);
          if (m) { html = r.view(m, params); activeTab = r.tab; break; }
        }
        if (!html) html = viewToday();
      } catch (e) {
        console.error(e);
        html = `<div class="empty-state"><div class="big">This view hit an error</div>${esc(e.message)}</div>`;
      }
      main.innerHTML = html;
      for (const [id, v] of Object.entries(keep)) {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = v;
      }
      if (focused) { const el = document.getElementById(focused); if (el) try { el.focus(); } catch (_) { /* gone */ } }

      UI.renderChrome(activeTab);
      App.observeSeen(main);
      window.scrollTo(0, App.uiScroll(path));
    },

    renderChrome(activeTab) {
      const nav = document.getElementById("nav");
      nav.innerHTML = NAV
        .filter(([to]) => to !== "#/deskroom" || App.state.deskMode)
        .map(([to, label]) => {
          const h = (location.hash || "#/").split("?")[0];
          const on = activeTab === to || h === to || (to !== "#/" && h.startsWith(to + "/"));
          return `<button class="nav-link ${on ? "active" : ""}" data-action="nav" data-to="${to}">${label}</button>`; }).join("");

      const newPins = (App.state.newPinIds || []).length;
      const deskNew = App.state.deskUnseenFlag ? 1 : 0;
      const tabbar = document.getElementById("tabbar");
      tabbar.innerHTML = '<div class="tabbar-inner">' + TABS.map(([to, label]) => {
        const active = to === activeTab;
        let badge = "";
        if (to === "#/" && newPins) badge = `<span class="badge">${newPins}</span>`;
        if (to === "#/desk" && deskNew) badge = '<span class="badge dot"></span>';
        const action = to === "more" ? 'data-action="more-sheet"' : `data-action="nav" data-to="${to}"`;
        return `<button class="tab-link ${active ? "active" : ""}" ${action}>${label}${badge}</button>`;
      }).join("") + "</div>";

      const fresh = Corpus.freshness();
      const pill = document.getElementById("mast-fresh");
      pill.textContent = App.state.sweeping ? "Updating…" : fresh.label;
      pill.className = "mast-chip " + fresh.cls;
      document.getElementById("mast-desk").hidden = !App.state.deskMode;
    },

    /* ---- sweep panel ---- */
    sweepPanel(stages) {
      const root = document.getElementById("sheet-root");
      root.innerHTML = `<div class="sweep-backdrop" data-action="sweep-hide"></div>
        <div class="sweep-panel" role="status" aria-label="Updating the wire">
          <div class="sweep-head">
            <span class="pulse-dot"></span>
            <span class="sweep-title">Updating the wire</span>
            <span class="sweep-clock">${esc(timeShort(Date.now()))}</span>
            <div class="scanbeam"></div>
          </div>
          <div class="sweep-stages">
            ${stages.map((s, i) => `<div class="sw-stage" data-i="${i}">
              <span class="sw-ic"><span class="sw-spin"></span></span>
              <span class="sw-label">${esc(s)}</span>
              <span class="sw-detail"></span>
            </div>`).join("")}
          </div>
          <div class="sweep-done" id="sweep-done" hidden></div>
        </div>`;
      requestAnimationFrame(() => {
        root.querySelector(".sweep-backdrop").classList.add("in");
        root.querySelector(".sweep-panel").classList.add("in");
      });
    },

    sweepStage(i, status, detail) {
      const row = document.querySelector(`.sw-stage[data-i="${i}"]`);
      if (!row) return;
      row.classList.remove("active", "done", "fail", "skip");
      row.classList.add(status);
      if (detail !== undefined) row.querySelector(".sw-detail").textContent = detail;
    },

    sweepFinish(summary, isError) {
      const done = document.getElementById("sweep-done");
      if (done) {
        done.textContent = summary;
        done.hidden = false;
        done.classList.toggle("err", !!isError);
      }
      const panel = document.querySelector(".sweep-panel");
      if (panel) panel.classList.add("landed");
      clearTimeout(UI._sweepT);
      UI._sweepT = setTimeout(() => UI.sweepHide(), isError ? 4200 : 1600);
    },

    sweepHide() {
      clearTimeout(UI._sweepT);
      const root = document.getElementById("sheet-root");
      const panel = root.querySelector(".sweep-panel");
      const bd = root.querySelector(".sweep-backdrop");
      if (panel) {
        panel.classList.remove("in");
        if (bd) bd.classList.remove("in");
        setTimeout(() => { if (root.querySelector(".sweep-panel") === panel) root.innerHTML = ""; }, 280);
      }
    },

    toast(msg, ms) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.classList.add("in");
      clearTimeout(UI._toastT);
      UI._toastT = setTimeout(() => el.classList.remove("in"), ms || 2600);
    },

    /* ---- sheets ---- */
    _sheetReturnFocus: null,
    sheet(html, onwire) {
      const root = document.getElementById("sheet-root");
      UI._sheetReturnFocus = document.activeElement;
      root.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
        <div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
      requestAnimationFrame(() => {
        root.querySelector(".sheet-backdrop").classList.add("in");
        const sh = root.querySelector(".sheet");
        sh.classList.add("in");
        const first = sh.querySelector("input, textarea, select, button");
        if (first) try { first.focus(); } catch (_) { /* fine */ }
      });
      if (onwire) onwire(root);
    },
    closeSheet() {
      const root = document.getElementById("sheet-root");
      const sh = root.querySelector(".sheet");
      const bd = root.querySelector(".sheet-backdrop");
      if (sh) { sh.classList.remove("in"); bd.classList.remove("in"); setTimeout(() => { root.innerHTML = ""; }, 260); }
      const back = UI._sheetReturnFocus;
      if (back && document.contains(back)) try { back.focus(); } catch (_) { /* gone */ }
      UI._sheetReturnFocus = null;
    },

    moreSheet() {
      const rows = [
        ["#/search", "Search"], ["#/brief", "Brief"], ["#/catchup", "Catch-up"], ["#/saved", "Saved"], ["#/sources", "Sources"], ["#/settings", "Settings"],
      ];
      if (App.state.deskMode) rows.splice(0, 0, ["#/deskroom", "Deskroom"]);
      UI.sheet(`<div class="sheet-list">${rows.map(([to, l]) =>
        `<button data-action="nav" data-to="${to}">${l}</button>`).join("")}
        <button data-action="lock-app">Lock InterDesk</button></div>`);
    },

    filterSheet(params) {
      const topics = Fatopics.list();
      const cur = params.get("t") || "";
      UI.sheet(`<h3>Filter</h3>
        <div class="chips" style="flex-wrap:wrap">${topics.map((t) =>
          `<button class="chip ${cur === t.id ? "active" : ""}" data-action="wire-topic" data-t="${t.id}">${esc(t.label)}</button>`).join("")}</div>
        <div class="sheet-row"><span>Show muted items</span>
          <label class="toggle"><input type="checkbox" data-action="wire-muted" ${params.get("muted") === "1" ? "checked" : ""}><span class="tr"></span></label></div>`);
    },

    longPressSheet(item) {
      const mutedTopic = (item.topicTags || [])[0];
      UI.sheet(`<h3>${esc(item.title.slice(0, 80))}</h3><div class="sheet-list">
        <button data-action="toggle-save" data-id="${esc(item.id)}">${App.isSaved(item.id) ? "Remove from saved" : "Save"}</button>
        ${mutedTopic ? `<button data-action="mute-topic" data-t="${esc(mutedTopic)}">Mute topic: ${esc(Fatopics.label(mutedTopic))}</button>` : ""}
        <button data-action="mute-source" data-s="${esc(item.sourceId)}">Mute source: ${esc(item.sourceName)}</button>
        <button data-action="copy-link" data-id="${esc(item.id)}">Copy title and link</button>
        ${App.state.deskMode ? `<button data-action="pin-sheet" data-id="${esc(item.id)}" data-scope="item">Pin to Today</button>
          <button data-action="respond-flag" data-id="${esc(item.id)}">Flag for response</button>` : ""}
      </div>`);
    },

    pinSheet(ref) {
      const existing = App.state.pins.find((p) => p.itemId === ref.id);
      UI.sheet(`<h3>${existing ? "Edit pin" : "Pin to Today"}</h3>
        <p class="dek">${esc(ref.title.slice(0, 120))}</p>
        <label class="f">Steer</label>
        <textarea id="pin-note" maxlength="280">${esc(existing ? existing.note || "" : "")}</textarea>
        <label class="f">Priority</label>
        <div class="seg" id="pin-priority">${["lead", "priority", "fyi"].map((p) =>
          `<button data-p="${p}" class="${(existing ? existing.priority : "priority") === p ? "active" : ""}">${cap(p)}</button>`).join("")}</div>
        <label class="f">Expires</label>
        <div class="seg" id="pin-ttl">${[[86400, "24 h"], [172800, "48 h"], [604800, "1 week"], [2592000, "30 days"]].map(([s, l], i) =>
          `<button data-s="${s}" class="${i === 2 ? "active" : ""}">${l}</button>`).join("")}</div>
        <div class="sheet-actions">
          <button class="btn" data-action="close-sheet">Cancel</button>
          <button class="btn primary" data-action="pin-save" data-id="${esc(ref.id)}" data-scope="${esc(ref.scope)}">${existing ? "Update" : "Pin"}</button>
        </div>`, (root) => {
        for (const seg of root.querySelectorAll("#pin-priority button, #pin-ttl button")) {
          seg.addEventListener("click", () => {
            for (const b of seg.parentElement.children) b.classList.remove("active");
            seg.classList.add("active");
          });
        }
      });
    },

    /* Article picker for the desk composer: pins first, then saved, then
       the leads of today's top storylines. Inserts a markdown link line. */
    deskInsertSheet() {
      const rows = [];
      const seen = new Set();
      const add = (item, tag) => {
        if (!item || seen.has(item.id)) return;
        seen.add(item.id);
        rows.push(`<button data-action="desk-insert-item" data-id="${esc(item.id)}">
          <span class="ins-tag">${tag}</span>${esc(item.title.slice(0, 90))}
          <span class="ins-src">${esc(item.via || item.sourceName || "")}</span></button>`);
      };
      for (const pin of App.sortedPins()) add(App.itemById(pin.itemId) || App.pinnedItemStub(pin.itemId), "Pinned");
      for (const s of App.state.saved.slice(0, 12)) add(App.itemById(s.id) || s, "Saved");
      for (const story of App.buildStories().list.slice(0, 12)) add(App.itemById((story.itemIds || [])[0]), "Wire");
      UI.sheet(`<h3>Insert an article</h3>
        <div class="sheet-list ins-list">${rows.join("") || '<p class="quiet">Nothing pinned or saved yet.</p>'}</div>`);
    },

    deskHistorySheet(past) {
      UI.sheet(`<h3>The Desk — ${esc(past.date)}</h3>
        <div class="sheet-scroll">${deskPageHtml(past)}</div>
        <div class="sheet-actions">
          <button class="btn" data-action="close-sheet">Close</button>
          <button class="btn primary" data-action="desk-history-reuse" data-id="${esc(past.id)}">Reuse as today's draft</button>
        </div>`);
    },

    respondSheet(item) {
      // The desk names who the response answers; the item's tagged
      // counterparts seed the choice, with the first preselected.
      const cps = (item.counterparts || []).map((c) => Sources.counterpart(c.id)).filter(Boolean);
      const cpRow = cps.length
        ? `<label class="f" id="resp-cp-label">Answers</label>
           <div class="chips" id="resp-cp" role="radiogroup" aria-labelledby="resp-cp-label" style="border-bottom:none">${cps.map((c, i) =>
             `<button type="button" role="radio" aria-checked="${i === 0}" class="chip ${i === 0 ? "active" : ""}" data-cp="${esc(c.id)}">${esc(c.surname)}</button>`).join("")}
             <button type="button" role="radio" aria-checked="false" class="chip" data-cp="">General</button></div>`
        : "";
      UI.sheet(`<h3>Flag for response</h3>
        <p class="dek">${esc(item.title.slice(0, 120))}</p>
        <p class="quiet">Goes to the shared response queue — the desk sees it immediately.</p>
        ${cpRow}
        <label class="f">What the response should do</label>
        <input type="text" id="resp-note" maxlength="200" placeholder="A line for media? A written question? A rebuttal?">
        <div class="sheet-actions">
          <button class="btn" data-action="close-sheet">Cancel</button>
          <button class="btn primary" data-action="respond-save" data-id="${esc(item.id)}">Flag it</button>
        </div>`, (root) => {
        for (const b of root.querySelectorAll("#resp-cp .chip")) {
          b.addEventListener("click", () => {
            for (const x of b.parentElement.children) { x.classList.remove("active"); x.setAttribute("aria-checked", "false"); }
            b.classList.add("active");
            b.setAttribute("aria-checked", "true");
          });
        }
      });
    },

    /* An already-flagged item: manage the flag rather than re-raise it. */
    respondManageSheet(flag) {
      const cp = flag.counterpartId ? Sources.counterpart(flag.counterpartId) : null;
      UI.sheet(`<h3>${flag.status === "done" ? "Responded" : "Flagged for response"}</h3>
        <p class="dek">${esc(flag.title.slice(0, 120))}</p>
        <p class="quiet">${esc([cp ? "Answers " + cp.surname : "", "flagged " + ago(flag.flaggedAt)].filter(Boolean).join(" · "))}</p>
        ${flag.note ? `<div class="flag-note">&ldquo;${esc(flag.note)}&rdquo;</div>` : ""}
        <div class="sheet-actions">
          ${flag.status === "done"
            ? `<button class="btn danger" data-action="respond-clear" data-id="${esc(flag.itemId)}">Clear from the record</button>`
            : `<button class="btn danger" data-action="respond-clear" data-id="${esc(flag.itemId)}">Clear flag</button>
               <button class="btn primary" data-action="respond-done" data-id="${esc(flag.itemId)}">Mark responded</button>`}
        </div>`);
    },

    /* World-clock slot picker: one tap swaps the preset. */
    clockZoneSheet(slot) {
      const current = (window.Clock ? Clock.slots() : [])[slot];
      const rows = (window.Clock ? Clock.zones() : []).map((z) =>
        `<button data-action="clock-zone-set" data-slot="${slot}" data-zone="${esc(z.id)}"
          class="${z.id === current ? "sel" : ""}" aria-pressed="${z.id === current}">
          ${esc(z.city)}<span class="ins-src">${esc(z.country)}</span>
        </button>`).join("");
      UI.sheet(`<h3>Show this clock as</h3>
        <div class="sheet-scroll"><div class="sheet-list ins-list">${rows}</div></div>`);
    },

    respondDoneSheet(flag) {
      UI.sheet(`<h3>Mark responded</h3>
        <p class="dek">${esc(flag.title.slice(0, 120))}</p>
        <label class="f">Link to the response</label>
        <input type="url" id="resp-url" placeholder="https://…" autocomplete="off">
        <div class="sheet-actions">
          <button class="btn" data-action="close-sheet">Cancel</button>
          <button class="btn primary" data-action="respond-done-save" data-id="${esc(flag.itemId)}">Done</button>
        </div>`);
    },
  };

  window.UI = UI;
})();
