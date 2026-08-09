/* parse.js — normalise RSS 2.0 / Atom / RDF / JSON Feed into wire items. */
(function () {
  function text(el, ...names) {
    for (const name of names) {
      const nodes = el.getElementsByTagName(name);
      if (nodes.length && nodes[0].textContent) return nodes[0].textContent.trim();
    }
    return "";
  }

  function stripHtml(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  function parseDate(s) {
    if (!s) return 0;
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    // interest.co.nz style: "27th Jul 26, 3:59pm"
    const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(\w{3})\w*\s+(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (m) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const mo = months[m[2].toLowerCase()];
      if (mo !== undefined) {
        let year = parseInt(m[3], 10);
        if (year < 100) year += 2000;
        let hour = parseInt(m[4], 10) % 12;
        if ((m[6] || "").toLowerCase() === "pm") hour += 12;
        // NZT is UTC+12 (NZST) / +13 (NZDT); +12 is close enough for ordering.
        return Date.UTC(year, mo, parseInt(m[1], 10), hour - 12, parseInt(m[5], 10));
      }
    }
    return 0;
  }

  // Stable id from the link (or title as fallback) — FNV-1a hash.
  function hashId(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return "i" + (h >>> 0).toString(36);
  }

  function atomLink(entry) {
    const links = entry.getElementsByTagName("link");
    let fallback = "";
    for (const l of links) {
      const href = l.getAttribute("href") || "";
      const rel = l.getAttribute("rel") || "alternate";
      if (rel === "alternate" && href) return href;
      if (href && !fallback) fallback = href;
    }
    return fallback;
  }

  function fromXml(xmlText, source) {
    let doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) {
      // Real feeds leak HTML-only entities (&nbsp; &sect; &rsquo;) or bare
      // ampersands, which are fatal in XML. Escape the offending '&' and retry
      // once; stripHtml() later decodes &amp;sect; back to the intended char.
      const repaired = xmlText.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g, "&amp;");
      doc = new DOMParser().parseFromString(repaired, "text/xml");
      if (doc.querySelector("parsererror")) throw new Error("XML parse error for " + source.id);
    }
    const items = [];

    // RSS 2.0 and RDF share <item>; Atom uses <entry>.
    let nodes = Array.from(doc.getElementsByTagName("item"));
    let isAtom = false;
    if (!nodes.length) {
      nodes = Array.from(doc.getElementsByTagName("entry"));
      isAtom = true;
    }

    for (const node of nodes) {
      const title = stripHtml(text(node, "title"));
      if (!title) continue;
      let link = "";
      if (isAtom) link = atomLink(node);
      else link = text(node, "link") || text(node, "guid");
      link = (link || "").trim();
      if (link && !/^https?:\/\//i.test(link)) link = "";

      const rawSummary =
        text(node, "description") || text(node, "summary") ||
        text(node, "content:encoded") || text(node, "content");
      const published = parseDate(
        text(node, "pubDate") || text(node, "published") || text(node, "updated") ||
        text(node, "dc:date") || text(node, "date")
      );

      // Extract structured fields from the FULL text before truncating for
      // display, so a late-appearing closing date is never lost.
      const fullSummary = stripHtml(rawSummary);
      const item = {
        id: hashId(link || source.id + "|" + title),
        sourceId: source.id,
        sourceName: source.name,
        stream: source.stream,
        region: source.region || "global",
        tier: source.tier || 2,
        title,
        link,
        summary: fullSummary.slice(0, 600),
        published: published || Date.now(),
        fetchedAt: Date.now(),
        storyId: null,
      };
      const meta = window.PaperTrail && PaperTrail.extract(source, title, fullSummary);
      if (meta) item.meta = meta;
      items.push(item);
    }
    return items;
  }

  function fromJsonFeed(jsonText, source) {
    const data = JSON.parse(jsonText);
    const list = data.items || [];
    return list.map((it) => ({
      id: hashId(it.url || it.id || source.id + "|" + (it.title || "")),
      sourceId: source.id,
      sourceName: source.name,
      stream: source.stream,
      region: source.region || "global",
      tier: source.tier || 2,
      title: stripHtml(it.title || "").trim(),
      link: /^https?:\/\//i.test(it.url || it.external_url || "") ? (it.url || it.external_url) : "",
      summary: stripHtml(it.summary || it.content_text || it.content_html || "").slice(0, 600),
      published: parseDate(it.date_published || it.date_modified) || Date.now(),
      fetchedAt: Date.now(),
      storyId: null,
    })).filter((i) => i.title);
  }

  const Parse = {
    feed(rawText, source) {
      const head = rawText.trimStart();
      let items = head.startsWith("{") ? fromJsonFeed(rawText, source) : fromXml(rawText, source);
      // Guard against absurd future dates or per-feed floods.
      const now = Date.now() + 6 * 3600 * 1000;
      items = items.filter((i) => i.published < now).slice(0, 60);
      return items;
    },
  };

  window.Parse = Parse;
})();
