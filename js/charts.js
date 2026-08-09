/* charts.js - SVG chart strings for The Gallery. Pure functions: data in,
   markup out. Views inject these via innerHTML, so nothing here touches the
   DOM and nothing holds a listener; interactivity rides entirely on data-tip
   attributes that a delegated handler elsewhere reads off .ch-mark nodes. */
(function () {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* Round coordinates to 2dp so the emitted markup stays legible. */
  function n2(v) {
    return Math.round(v * 100) / 100;
  }

  /* ---------- NZ calendar days ----------
     A "day" here is a Pacific/Auckland calendar day, not a UTC one: the wire
     runs on NZ time, and a story filed at 11pm belongs to that evening rather
     than to tomorrow morning UTC. Same approach as ui.js, reimplemented
     locally so this module stands alone. One formatter for the session:
     construction is expensive, reuse is not, and dayBuckets runs this per
     timestamp. */
  const NZ_YMD = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit",
  });
  function nzParts(ts) {
    const f = NZ_YMD.formatToParts(new Date(ts));
    const g = (t) => Number(f.find((p) => p.type === t).value);
    return { y: g("year"), m: g("month"), d: g("day") };
  }
  function nzDayIndex(ts) {
    const { y, m, d } = nzParts(ts);
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /* Reverse of nzDayIndex: the index is a UTC day count, so reading the UTC
     fields of index * 86400000 recovers the calendar date exactly. Stepping
     back 24h at a time would drift across NZ daylight-saving changes. */
  function dayInfo(idx) {
    const d = new Date(idx * 86400000);
    const iso = d.getUTCFullYear() + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0");
    return { dayISO: iso, label: d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] };
  }

  function dayBuckets(timestamps, { days = 14, endTs = null } = {}) {
    const endIdx = nzDayIndex(endTs == null ? Date.now() : endTs);
    const startIdx = endIdx - (days - 1);
    const buckets = [];
    for (let i = 0; i < days; i++) {
      const info = dayInfo(startIdx + i);
      buckets.push({ dayISO: info.dayISO, label: info.label, n: 0 });
    }
    for (const ts of timestamps || []) {
      const off = nzDayIndex(ts) - startIdx;
      if (off >= 0 && off < days) buckets[off].n++;
    }
    return buckets;
  }

  /* ---------- bars ----------
     Shared bar geometry. Visibility rules: a count of 1 against a peak of 40
     must still register as ink (1px floor), and a zero day must read as
     "measured, empty" rather than vanish, hence the 1px stub in the rule
     colour. The last bucket is today, the live edge, and prints in red. */
  function barRects(buckets, x0, y0, plotW, plotH) {
    const max = Math.max(1, ...buckets.map((b) => b.n));
    const step = plotW / buckets.length;
    const bw = Math.max(1, n2(step - Math.min(2, step * 0.25)));
    let out = "";
    buckets.forEach((b, i) => {
      const zero = !b.n;
      const bh = zero ? 1 : Math.max(1, n2((b.n / max) * plotH));
      const fill = zero ? "var(--rule)" : (i === buckets.length - 1 ? "var(--red)" : "var(--ink)");
      const tip = b.label + " · " + b.n + (b.n === 1 ? " item" : " items");
      out += `<rect class="ch-mark" x="${n2(x0 + i * step)}" y="${n2(y0 + plotH - bh)}" ` +
        `width="${bw}" height="${bh}" fill="${fill}" data-tip="${esc(tip)}"></rect>`;
    });
    return out;
  }

  function spark(buckets, { w = 300, h = 36 } = {}) {
    const bs = buckets || [];
    const total = bs.reduce((a, b) => a + b.n, 0);
    const aria = "Activity: " + total + (total === 1 ? " item" : " items") + " over " + bs.length + " days";
    let svg = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(aria)}">`;
    if (bs.length) svg += barRects(bs, 0, 0, w, h - 1);
    svg += `<rect x="0" y="${h - 1}" width="${w}" height="1" fill="var(--rule-2)"></rect>`;
    return svg + "</svg>";
  }

  function bars(buckets, { w = 280, h = 64 } = {}) {
    const bs = buckets || [];
    const max = bs.length ? Math.max(...bs.map((b) => b.n)) : 0;
    const first = bs.length ? bs[0].label : "";
    const last = bs.length ? bs[bs.length - 1].label : "";
    // Reserve headroom for the peak readout and a footer strip for the dates.
    const top = 13;
    const bottom = 12;
    const plotH = Math.max(4, h - top - bottom);
    const aria = "Daily volume, peak " + max + (first ? ", " + first + " to " + last : "");
    let svg = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(aria)}">`;
    svg += `<text x="0" y="8" font-family="var(--mono)" font-size="9" letter-spacing="1" fill="var(--ink-3)">peak ${max}</text>`;
    if (bs.length) svg += barRects(bs, 0, top, w, plotH);
    svg += `<rect x="0" y="${top + plotH}" width="${w}" height="1" fill="var(--rule-2)"></rect>`;
    svg += `<text x="0" y="${h - 2}" font-family="var(--mono)" font-size="8.5" fill="var(--ink-3)">${esc(first)}</text>`;
    svg += `<text x="${w}" y="${h - 2}" text-anchor="end" font-family="var(--mono)" font-size="8.5" fill="var(--ink-3)">${esc(last)}</text>`;
    return svg + "</svg>";
  }

  /* ---------- lines ----------
     Poll-track style multi-series chart. X is scaled by time, never by index:
     polls land unevenly (three in a fortnight, then a two-month gap) and
     index scaling would flatten exactly the gaps a reader needs to see. */

  /* A grid step that lands on 1/2/5 boundaries so labels read like numbers a
     subeditor would print, not 7.33s. */
  function niceStep(raw) {
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    const unit = raw / mag;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * mag;
  }

  function lines(series, { w = 620, h = 230, yMax = null, threshold = null, thresholdLabel = "" } = {}) {
    const list = (series || []).filter((s) => s && s.points && s.points.length);
    const allPts = [];
    for (const s of list) for (const p of s.points) allPts.push(p);
    const open = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"`;
    if (!list.length || allPts.length < 2) {
      return open + ` aria-label="No data available">` +
        `<text x="${n2(w / 2)}" y="${n2(h / 2)}" text-anchor="middle" font-family="var(--mono)" ` +
        `font-size="10" letter-spacing="1.5" fill="var(--ink-3)">NO DATA</text></svg>`;
    }
    const padL = 30, padR = 58, padT = 10, padB = 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const xMin = Math.min(...allPts.map((p) => p.x));
    const xMax = Math.max(...allPts.map((p) => p.x));
    const xSpan = Math.max(1, xMax - xMin);
    // The threshold rides in the scale too, so a 5% line above quiet data
    // still prints instead of falling off the top of the chart.
    const dataMax = Math.max(...allPts.map((p) => p.y), threshold == null ? 0 : threshold);
    const yTop = yMax != null ? yMax : (dataMax * 1.1 || 1);
    const X = (x) => n2(padL + ((x - xMin) / xSpan) * plotW);
    const Y = (y) => n2(padT + plotH - (y / yTop) * plotH);
    const aria = "Line chart: " + list.map((s) => s.name).join(", ") + ", " + allPts.length + " points";
    let svg = open + ` aria-label="${esc(aria)}">`;

    // Y grid: hairlines at nice values, labels in the left margin.
    const yStep = niceStep(yTop / 4);
    for (let v = yStep; v <= yTop; v += yStep) {
      const y = Y(v);
      svg += `<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="var(--rule)" stroke-width="1"></line>`;
      svg += `<text x="${padL - 5}" y="${n2(y + 3)}" text-anchor="end" font-family="var(--mono)" font-size="9" fill="var(--ink-3)">${n2(v)}</text>`;
    }

    // X axis: NZ-calendar date labels at even time positions. Under two
    // months we print days; longer spans print months, with a 2-digit year
    // stamped whenever the year changes so "Jan" is never ambiguous.
    let prevYear = null;
    for (let i = 0; i < 5; i++) {
      const t = xMin + (xSpan * i) / 4;
      const p = nzParts(t);
      let lab;
      if (xSpan < 60 * 86400000) {
        lab = p.d + " " + MONTHS[p.m - 1];
      } else {
        lab = MONTHS[p.m - 1] + (prevYear === p.y ? "" : " " + String(p.y).slice(2));
        prevYear = p.y;
      }
      const anchor = i === 0 ? "start" : (i === 4 ? "end" : "middle");
      svg += `<text x="${X(t)}" y="${h - 6}" text-anchor="${anchor}" font-family="var(--mono)" ` +
        `font-size="9" letter-spacing="0.5" fill="var(--ink-3)">${esc(lab)}</text>`;
    }
    svg += `<rect x="${padL}" y="${padT + plotH}" width="${plotW}" height="1" fill="var(--rule-2)"></rect>`;

    if (threshold != null) {
      const ty = Y(threshold);
      svg += `<line x1="${padL}" y1="${ty}" x2="${padL + plotW}" y2="${ty}" stroke="var(--rule-2)" stroke-width="1" stroke-dasharray="4 3"></line>`;
      if (thresholdLabel) {
        svg += `<text x="${padL + plotW + 4}" y="${n2(ty + 3)}" font-family="var(--mono)" font-size="8.5" fill="var(--ink-3)">${esc(thresholdLabel)}</text>`;
      }
    }

    const tags = [];
    for (const s of list) {
      const pts = s.points.slice().sort((a, b) => a.x - b.x);
      const color = esc(s.color);
      svg += `<polyline points="${pts.map((p) => X(p.x) + "," + Y(p.y)).join(" ")}" ` +
        `fill="none" stroke="${color}" stroke-width="2"></polyline>`;
      for (const p of pts) {
        const tip = s.name + " " + p.y + " · " + (p.label || "");
        svg += `<circle class="ch-mark" cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${color}" data-tip="${esc(tip)}"></circle>`;
      }
      tags.push({ name: s.name, color, y: Y(pts[pts.length - 1].y) + 3 });
    }

    // Right-edge series labels. Two parties polling within a point of each
    // other would overprint, so: sort by y, open a minimum gap top-down, then
    // pull the stack back up if the last label ran off the bottom.
    tags.sort((a, b) => a.y - b.y);
    for (let i = 1; i < tags.length; i++) {
      if (tags[i].y < tags[i - 1].y + 10) tags[i].y = tags[i - 1].y + 10;
    }
    for (let i = tags.length - 1; i >= 0; i--) {
      const limit = i === tags.length - 1 ? padT + plotH : tags[i + 1].y - 10;
      if (tags[i].y > limit) tags[i].y = limit;
    }
    for (const t of tags) {
      svg += `<text x="${padL + plotW + 6}" y="${n2(t.y)}" font-family="var(--mono)" font-size="9" ` +
        `letter-spacing="0.5" fill="${t.color}">${esc(t.name)}</text>`;
    }
    return svg + "</svg>";
  }

  window.Charts = { dayBuckets, spark, bars, lines };
})();
