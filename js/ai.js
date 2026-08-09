/* ai.js — the editorial brain. Direct browser calls to the Anthropic API
   (user's own key, entered in Settings; nothing is proxied through a server).
   Jobs:
     1. synthesize()         — consolidate wire clusters into living storylines (structured output)
     2. nameStories()        — cheap naming pass for heuristic groups
     3. streamBrief()        — the spokesperson's morning brief (streaming markdown)
     4. streamBackgrounder() — one-story deep brief, optionally with live web search
     6. verify()             — SAFE/HEDGE/AVOID claim check against the desk's own material
*/
(function () {
  const API_URL = "https://api.anthropic.com/v1/messages";
  const VERSION = "2023-06-01";

  const MODELS = [
    { id: "claude-opus-5", label: "Claude Opus 5 (default, most capable)" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5 (faster, cheaper)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (cheapest, frequent sweeps)" },
  ];

  /* The 12 InterDesk topic ids — mirror data/topics.json. */
  const TOPIC_IDS = [
    "nz-govt-moves", "pacific-region", "china-indopacific", "us-allies",
    "aukus-defence", "intelligence", "trade-economy", "multilateral-law",
    "climate-pacific", "immigration-consular", "principal-mentions", "crisis-watch",
  ];

  function headers(apiKey, betas) {
    const h = {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (betas && betas.length) h["anthropic-beta"] = betas.join(",");
    return h;
  }

  function supportsFallbacks(model) {
    return model.startsWith("claude-opus-5") || model.startsWith("claude-fable-5");
  }

  async function apiError(res) {
    let msg = "HTTP " + res.status;
    try {
      const data = await res.json();
      if (data.error && data.error.message) msg = data.error.type + ": " + data.error.message;
    } catch (_) { /* keep status text */ }
    return new Error(msg);
  }

  /* ---------- non-streaming call ---------- */
  async function createMessage(body, apiKey) {
    const betas = [];
    if (supportsFallbacks(body.model)) {
      body = { ...body, fallbacks: "default" };
      betas.push("server-side-fallback-2026-07-01");
    }
    let res = await fetch(API_URL, { method: "POST", headers: headers(apiKey, betas), body: JSON.stringify(body) });
    if (res.status === 400 && body.fallbacks) {
      // Org may not have the fallback beta — retry plainly.
      const { fallbacks, ...plain } = body;
      res = await fetch(API_URL, { method: "POST", headers: headers(apiKey, []), body: JSON.stringify(plain) });
    }
    if (!res.ok) throw await apiError(res);
    const data = await res.json();
    if (data.stop_reason === "refusal") {
      throw new Error("Claude's safety classifiers declined this request. Try rephrasing, or a different model in Settings.");
    }
    if (data.stop_reason === "max_tokens") {
      throw new Error("Hit the token limit mid-response. The next sweep retries with fewer clusters.");
    }
    return data;
  }

  /* ---------- streaming call with server-tool pause_turn continuation ---------- */
  async function streamMessage(body, apiKey, onDelta, signal, { idleMs = 90000 } = {}) {
    const messages = body.messages.slice();
    let fullText = "";

    /* Stall watchdog: a stream that produces no frames for idleMs is dead
       (proxy hang, dropped connection) and would otherwise spin forever. The
       internal controller chains the caller's signal so user-cancel still
       aborts, and the two cases are distinguished on the way out. */
    const ac = new AbortController();
    let idleTimer = null;
    let stalled = false;
    const kick = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; ac.abort(); }, idleMs);
    };
    if (signal) {
      if (signal.aborted) ac.abort();
      else signal.addEventListener("abort", () => ac.abort(), { once: true });
    }

    try {
      for (let leg = 0; leg < 6; leg++) {
        kick();
        const legBody = { ...body, messages, stream: true };
        const betas = [];
        if (supportsFallbacks(body.model)) {
          legBody.fallbacks = "default";
          betas.push("server-side-fallback-2026-07-01");
        }
        let res = await fetch(API_URL, {
          method: "POST", headers: headers(apiKey, betas), body: JSON.stringify(legBody), signal: ac.signal,
        });
        if (res.status === 400 && legBody.fallbacks) {
          delete legBody.fallbacks;
          res = await fetch(API_URL, {
            method: "POST", headers: headers(apiKey, []), body: JSON.stringify(legBody), signal: ac.signal,
          });
        }
        if (!res.ok) throw await apiError(res);

        const result = await consumeStream(res, (t) => {
          fullText += t;
          if (onDelta) onDelta(t, fullText);
        }, kick);

        if (result.stopReason === "refusal") {
          throw new Error("Claude's safety classifiers declined this request. Try rephrasing, or a different model in Settings.");
        }
        if (result.stopReason !== "pause_turn") return { text: fullText, stopReason: result.stopReason };

        // Server-side tool loop paused — resume with the accumulated assistant turn.
        messages.push({ role: "assistant", content: result.blocks });
      }
      return { text: fullText, stopReason: "pause_turn" };
    } catch (err) {
      if (stalled && err.name === "AbortError") {
        throw new Error("Stream stalled: no data for " + Math.round(idleMs / 1000) + " seconds. Any partial text is preserved.");
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }
  }

  /* Parse the SSE stream; emit text deltas; rebuild content blocks so a
     pause_turn continuation can echo the assistant turn back faithfully.
     kick (optional) re-arms the caller's stall watchdog per chunk. */
  async function consumeStream(res, emitText, kick) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const blocks = [];
    const acc = {}; // index -> {json, thinking, signature}
    let stopReason = null;
    let fatal = null;

    function handleEvent(data) {
      if (data.type === "error") {
        // Mid-stream API error (e.g. overloaded_error): the stream will close;
        // surface it instead of returning the partial text as a success.
        fatal = (data.error && (data.error.type + ": " + data.error.message)) || "stream error";
      } else if (data.type === "content_block_start") {
        blocks[data.index] = data.content_block;
        acc[data.index] = { json: "", thinking: "", signature: "" };
      } else if (data.type === "content_block_delta") {
        const d = data.delta;
        const a = acc[data.index] || (acc[data.index] = { json: "", thinking: "", signature: "" });
        if (d.type === "text_delta") {
          blocks[data.index].text = (blocks[data.index].text || "") + d.text;
          emitText(d.text);
        } else if (d.type === "input_json_delta") {
          a.json += d.partial_json;
        } else if (d.type === "thinking_delta") {
          a.thinking += d.thinking || "";
        } else if (d.type === "signature_delta") {
          a.signature += d.signature || "";
        }
      } else if (data.type === "content_block_stop") {
        const b = blocks[data.index];
        const a = acc[data.index];
        if (b && a) {
          if (a.json) { try { b.input = JSON.parse(a.json); } catch (_) { b.input = {}; } }
          if (b.type === "thinking") {
            b.thinking = a.thinking || b.thinking || "";
            if (a.signature) b.signature = a.signature;
          }
        }
      } else if (data.type === "message_delta") {
        if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
      }
    }

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (kick) kick();
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let data = null;
          try { data = JSON.parse(payload); } catch (_) { /* skip malformed frame */ }
          if (data) handleEvent(data);
        }
      }
      if (fatal) break;
    }
    if (fatal) throw new Error(fatal);
    return { blocks: blocks.filter(Boolean), stopReason };
  }

  /* Haiku 4.5 predates the _20260209 dynamic-filtering tool variants; it takes
     the basic web tools instead (a _20260209 request would 400). */
  function webTools(model, searchUses, fetchUses) {
    const modern = !model.startsWith("claude-haiku");
    return modern
      ? [
          { type: "web_search_20260209", name: "web_search", max_uses: searchUses },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: fetchUses },
        ]
      : [
          { type: "web_search_20250305", name: "web_search", max_uses: searchUses },
          { type: "web_fetch_20250910", name: "web_fetch", max_uses: fetchUses },
        ];
  }

  /* ---------- editorial context blocks ---------- */
  function contextBlock(settings) {
    const fa = window.FADATA ? window.FADATA.aiContext() : "";
    return (
      "Today is " + new Date().toLocaleDateString("en-NZ", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "Pacific/Auckland" }) +
      " (NZT).\nThe reader: Vanushi Walters, Labour's Foreign Affairs spokesperson (opposition), and her comms desk. " +
      "Outputs support scrutiny of the Government's foreign policy.\n" +
      (fa ? "\nCurrent foreign-affairs context (verified August 2026):\n" + fa : "")
    );
  }

  const SYNTH_SYSTEM =
    "You are the chief of staff of a foreign-affairs desk serving a New Zealand readership. Your job is to maintain LIVING STORYLINES: " +
    "single consolidated stories that absorb every new wire item about the same underlying event or issue.\n\n" +
    "You are given (a) the current storyline index and (b) new clusters of wire items. For each cluster, either " +
    "fold it into an existing storyline (return that storyline id, rewritten with the new details) or open a new " +
    "storyline. Merge clusters that cover the same event. Leave genuinely trivial or unrelated clusters out.\n\n" +
    "Naming rules, so a reader can see the shape of the story at a glance:\n" +
    "- topic is the durable subject line the story lives under, 2-4 words, reused verbatim across every update " +
    "to the same storyline ('AUKUS Pillar 2', not 'PM signals openness to AUKUS'). It is a filing label, not a headline.\n" +
    "- headline states what has happened overall, in under 90 characters. Write the story's headline, not one " +
    "outlet's angle on it, and never a question, teaser or 'Watch:' construction.\n" +
    "- When updating an existing storyline, keep the topic and only move the headline if the story itself has moved on.\n\n" +
    "Rules for the consolidated narrative:\n" +
    "- Rewrite it as ONE up-to-date account: newest confirmed details supersede earlier reporting; corrections replace errors.\n" +
    "- Use ONLY facts present in the supplied items. Never invent quotes, numbers, dates or names.\n" +
    "- Where sources conflict, say so explicitly ('RNZ reports X; Reuters puts it at Y').\n" +
    "- Attribute contested claims to their source. Keep the register neutral wire-service prose, 2-4 short paragraphs.\n" +
    "- whatsNew lists only what THIS update added or changed, one crisp line each.\n" +
    "- keyFacts are standalone verifiable facts with numbers/dates where available. Every fact cites the " +
    "supplied items that support it via refs (clusterRef.itemIndex, e.g. 'c2.0'). A fact no supplied item " +
    "supports does not belong in keyFacts; only a fact carried over unchanged from the existing storyline " +
    "may have empty refs.\n" +
    "- positions captures where the NZ Government, other governments and key actors stand, from the items only.\n" +
    "- significance: 5 = leads bulletins or moves NZ policy; 3 = solid regional/portfolio story; 1 = minor.\n" +
    "- nzInterest: 'direct' only when New Zealand, its government, its citizens or its portfolio obligations are " +
    "explicitly engaged; 'watching' when a regional development demonstrably bears on NZ policy (state the " +
    "mechanism in angle); otherwise 'background'. The angle must be defensible, not speculative.\n" +
    "- topics: file the storyline under every taxonomy id that genuinely applies.\n" +
    "- election: true when the story materially bears on the 2026 general election campaign.\n" +
    "- No emojis. No em dashes.";

  const SYNTH_SCHEMA = {
    type: "object",
    additionalProperties: false,
    required: ["storylines"],
    properties: {
      storylines: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["existingId", "clusterRefs", "topic", "headline", "dek", "narrative", "whatsNew",
            "keyFacts", "positions", "significance", "streams", "nzInterest", "topics", "tags", "election"],
          properties: {
            existingId: { type: "string", description: "id of the storyline being updated, or empty string for a new storyline" },
            clusterRefs: { type: "array", items: { type: "string" }, description: "cluster refs folded into this storyline" },
            topic: { type: "string", description: "2-4 word canonical label naming the ongoing subject, e.g. 'AUKUS Pillar 2', 'Cook Islands relations', 'India FTA'. Reuse the existing storyline's topic verbatim when updating one." },
            headline: { type: "string", description: "the whole story in one line, under 90 characters" },
            dek: { type: "string", description: "one-sentence standfirst" },
            narrative: { type: "string", description: "consolidated account, markdown, 2-4 short paragraphs" },
            whatsNew: { type: "array", items: { type: "string" } },
            keyFacts: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["fact", "refs"],
                properties: {
                  fact: { type: "string" },
                  refs: {
                    type: "array", items: { type: "string" },
                    description: "supplied wire items supporting this fact, as clusterRef.itemIndex (e.g. 'c2.0'); empty only when the fact is carried over from the existing storyline",
                  },
                },
              },
            },
            positions: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["actor", "position"],
                properties: { actor: { type: "string" }, position: { type: "string" } },
              },
            },
            significance: { type: "integer", enum: [1, 2, 3, 4, 5] },
            streams: { type: "array", items: { type: "string", enum: ["nz-media", "nz-official", "nz-parliament", "pacific", "pacific-official", "global", "global-official", "analysis", "principals"] } },
            nzInterest: {
              type: "object", additionalProperties: false, required: ["level", "angle"],
              properties: {
                level: { type: "string", enum: ["direct", "watching", "background"] },
                angle: { type: "string" },
              },
            },
            topics: { type: "array", items: { type: "string", enum: TOPIC_IDS }, description: "InterDesk topic taxonomy ids that genuinely apply" },
            tags: { type: "array", items: { type: "string" } },
            election: { type: "boolean" },
          },
        },
      },
    },
  };

  /* Deterministic safety net under the prompt-level "no em dashes, no emojis"
     rule: prompts ask, this enforces. Touches ONLY U+2014/U+2013 and
     pictographs. ASCII hyphens carry markdown lists, rules and tables and are
     never rewritten; runs of spaces collapse only mid-line so nested-list
     indentation survives. */
  function scrub(text) {
    if (!text) return text;
    return String(text)
      .replace(/(\d)\u2013(\d)/g, "$1-$2")               // numeric range: 2-4
      .replace(/\s*[\u2014\u2013]\s*/g, ", ")             // em/en dash -> comma
      .replace(/\p{Extended_Pictographic}/gu, "")          // emoji
      .replace(/[\uFE0F\u200D\u20E3]/g, "")                // emoji joiners/keycaps
      .replace(/([^\s]) {2,}/g, "$1 ")                     // mid-line runs only
      .replace(/ ([.,!?;:])/g, "$1");
  }

  /* Scrub every string in a parsed structured-output object. Safe on ids and
     refs: they are base36/positional and contain no dashes or pictographs. */
  function scrubDeep(v) {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(scrubDeep);
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) v[k] = scrubDeep(v[k]);
    }
    return v;
  }

  const VERIFY_SYSTEM =
    "You are the fact-check desk of a foreign-affairs newsroom serving a New Zealand readership, running the " +
    "final read on a draft before the spokesperson's office relies on it. Check every factual claim in the " +
    "draft against ONLY the supplied desk material and context.\n" +
    "For each claim you check, return:\n" +
    "- quote: the claim exactly as it appears in the draft, under 140 characters.\n" +
    "- verdict: SAFE (supported by the material), HEDGE (true only with a qualifier), or AVOID (contradicted, " +
    "outdated, or not supported by anything supplied).\n" +
    "- note: one line naming the supporting or contradicting source, or 'not covered by the archive'.\n" +
    "- fix: for HEDGE and AVOID, the safer wording; empty for SAFE.\n" +
    "Check facts, not style: numbers, dates, names, quotes and attributions first. " +
    "No emojis. No em dashes.";

  const VERIFY_SCHEMA = {
    type: "object", additionalProperties: false, required: ["claims", "overall"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object", additionalProperties: false, required: ["quote", "verdict", "note", "fix"],
          properties: {
            quote: { type: "string" },
            verdict: { type: "string", enum: ["SAFE", "HEDGE", "AVOID"] },
            note: { type: "string" },
            fix: { type: "string" },
          },
        },
      },
      overall: { type: "string", description: "one line: safe to use as-is, or what to fix first" },
    },
  };

  const AI = {
    MODELS,
    scrub,

    ready(settings) {
      return Boolean(settings && settings.apiKey);
    },

    /* Stage B: consolidate clusters into storylines. Returns parsed directives. */
    async synthesize(clusters, storylines, settings) {
      const recent = storylines
        .slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
        .map((s) => ({ id: s.id, topic: s.topic, headline: s.headline, dek: s.dek, tags: (s.tags || []).slice(0, 10), updated: new Date(s.updatedAt).toISOString().slice(0, 16) }));

      const clusterPayload = clusters.slice(0, 25).map((c, i) => ({
        ref: "c" + i,
        items: c.items.slice(0, 8).map((it) => ({
          source: it.sourceName, stream: it.stream, region: it.region,
          tags: (it.topicTags || []).slice(0, 4),
          title: it.title, summary: (it.summary || "").slice(0, 220),
          published: new Date(it.published).toISOString().slice(0, 16),
        })),
      }));

      const body = {
        model: settings.synthModel || settings.model || "claude-opus-5",
        max_tokens: 16000,
        system: [
          { type: "text", text: SYNTH_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: contextBlock(settings) },
        ],
        messages: [{
          role: "user",
          content:
            "CURRENT STORYLINE INDEX:\n" + JSON.stringify(recent) +
            "\n\nNEW WIRE CLUSTERS:\n" + JSON.stringify(clusterPayload) +
            "\n\nConsolidate. Return every cluster worth covering; omit only trivia.",
        }],
        output_config: { format: { type: "json_schema", schema: SYNTH_SCHEMA }, effort: "medium" },
      };

      const data = await createMessage(body, settings.apiKey);
      const textBlock = (data.content || []).find((b) => b.type === "text");
      if (!textBlock) throw new Error("Synthesis returned no content (stop: " + data.stop_reason + ")");
      const parsed = scrubDeep(JSON.parse(textBlock.text));
      parsed._usage = data.usage;
      parsed._clusterCount = clusterPayload.length;
      return parsed;
    },

    /* Cheap naming pass: give auto-grouped storylines a factual headline and a
       topic without paying for full narrative synthesis. Also reports clusters
       whose members do not actually belong together, which the heuristic
       tether test cannot see. */
    async nameStories(groups, settings) {
      const schema = {
        type: "object", additionalProperties: false, required: ["stories"],
        properties: {
          stories: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["ref", "topic", "headline", "coherent", "outliers"],
              properties: {
                ref: { type: "string" },
                topic: { type: "string", description: "2-4 word durable subject label" },
                headline: { type: "string", description: "one factual line, under 90 characters, covering what the group collectively reports" },
                coherent: { type: "boolean", description: "true when every listed item is genuinely the same story" },
                outliers: { type: "array", items: { type: "integer" }, description: "0-based indexes of items that do not belong with the rest" },
              },
            },
          },
        },
      };

      const payload = groups.slice(0, 40).map((g) => ({
        ref: g.ref,
        items: g.items.slice(0, 8).map((i) => ({ source: i.sourceName, title: i.title, at: new Date(i.published).toISOString().slice(0, 10) })),
      }));

      const body = {
        model: settings.synthModel || settings.model || "claude-opus-5",
        max_tokens: 8000,
        system: [{
          type: "text",
          text:
            "You are a wire editor naming stories for a foreign-affairs desk serving a New Zealand readership.\n" +
            "For each group of articles, write:\n" +
            "- topic: the durable 2-4 word subject the story files under ('AUKUS Pillar 2', 'Cook Islands relations').\n" +
            "- headline: ONE factual line under 90 characters describing what the group collectively reports. " +
            "Use only what the supplied titles support. Do not adopt a single outlet's angle, do not use questions, " +
            "teasers, 'Watch:'/'Live:' constructions, or clickbait. Prefer the concrete claim over the reaction to it.\n" +
            "- coherent: false if the items are not all the same story.\n" +
            "- outliers: indexes of any items that do not belong.\n" +
            "Never invent facts, names or numbers that the titles do not contain. No emojis. No em dashes.",
          cache_control: { type: "ephemeral", ttl: "1h" },
        }],
        messages: [{ role: "user", content: JSON.stringify(payload) }],
        output_config: { format: { type: "json_schema", schema }, effort: "low" },
      };

      const data = await createMessage(body, settings.apiKey);
      const block = (data.content || []).find((b) => b.type === "text");
      if (!block) throw new Error("Naming pass returned no content");
      const parsed = scrubDeep(JSON.parse(block.text));
      parsed._usage = data.usage;
      return parsed;
    },

    /* Morning brief: works from the archive, streams markdown. */
    async streamBrief(payload, settings, onDelta, signal) {
      const body = {
        model: settings.model || "claude-opus-5",
        max_tokens: 24000,
        system: [
          {
            type: "text",
            text:
              "You are chief of staff to the opposition Foreign Affairs spokesperson, writing her morning brief.\n" +
              "Write tight, factual, well-organised markdown. Structure, exactly these headings:\n" +
              "## Overnight global - what moved internationally and why it matters to NZ\n" +
              "## Pacific watch - the region, including what official Pacific sources published\n" +
              "## What the Government did - ministers' and officials' actual statements and actions, with dates\n" +
              "## What to raise - where scrutiny is warranted today, each line grounded\n" +
              "## On the radar - upcoming dates and decision points\n" +
              "Hard rules:\n" +
              "- Every suggested line must be grounded in the supplied storylines or the HER POSITIONS context; nothing free-floating.\n" +
              "- Label judgment as 'Judgment call:'.\n" +
              "- Never invent a government statement to attack. If the Government has not spoken, say so.\n" +
              "- Note where the Government's position is actually defensible, so she is not ambushed.\n" +
              "- Skip empty sections. Do not pad.\n" +
              "- No emojis. No em dashes.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          { type: "text", text: contextBlock(settings) },
        ],
        messages: [{
          role: "user",
          content: "DESK MATERIAL (storylines and recent wire items):\n" + JSON.stringify(payload) +
            "\n\nWrite the morning brief.",
        }],
      };
      return streamMessage(body, settings.apiKey, onDelta, signal);
    },

    /* The Desk draft: the daily page the comms team edits and ships to
       Vanushi. Unlike the self-serve brief this is written TO her, carries
       the desk's voice, and reads the last few shipped desks so running
       stories continue instead of restarting. The draft is a starting
       point — the team rewrites freely before shipping. */
    async streamDeskDraft(payload, settings, onDelta, signal) {
      const body = {
        model: settings.model || "claude-opus-5",
        max_tokens: 16000,
        system: [
          {
            type: "text",
            text:
              "You draft The Desk: the daily page Vanushi Walters' comms team ships to her each morning. " +
              "You write the first draft; the team edits it before it goes out, so favour substance over polish.\n" +
              "Voice: her own staff writing to her. Direct, warm-professional, second person where natural ('worth your time', 'you'll be asked about'). Never robotic, never breathless.\n" +
              "Shape (markdown, keep it under ~500 words):\n" +
              "- Open with two or three sentences on the day: what actually matters and why.\n" +
              "- '## Read these' - 3-5 items, each one line: what it is and the reason it earns her time.\n" +
              "- '## Running stories' - continue threads from PAST DESKS if supplied; say what moved since. Drop threads that have gone quiet.\n" +
              "- '## Coming up' - only if there are real dates.\n" +
              "Hard rules:\n" +
              "- Everything grounded in the supplied material; nothing invented.\n" +
              "- Continue past-desk threads by what CHANGED, never re-summarise old ground.\n" +
              "- Skip any section with nothing real to say.\n" +
              "- No emojis. No em dashes. No sign-off.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          { type: "text", text: contextBlock(settings) },
        ],
        messages: [{
          role: "user",
          content: "TODAY'S MATERIAL (top storylines, pins, open response flags):\n" + JSON.stringify(payload.material) +
            (payload.pastDesks && payload.pastDesks.length
              ? "\n\nPAST DESKS (newest first, for continuity):\n" + JSON.stringify(payload.pastDesks)
              : "") +
            "\n\nDraft today's Desk (" + payload.dateNZ + ").",
        }],
      };
      return streamMessage(body, settings.apiKey, onDelta, signal);
    },

    /* One-story deep brief. opts.web adds live search and fetch for the
       run-up and primary documents; without it the material supplied is the
       whole evidentiary world. */
    async streamBackgrounder(payload, settings, onDelta, signal, { web = false } = {}) {
      const model = settings.model || "claude-opus-5";
      const body = {
        model,
        max_tokens: web ? 32000 : 16000,
        system: [
          {
            type: "text",
            text:
              "You are a foreign-policy analyst briefing the spokesperson on ONE story.\n" +
              "Write tight, factual markdown. Structure, exactly these headings:\n" +
              "## What happened - the event itself, from the supplied items\n" +
              "## How we got here - the run-up, with dates; mark anything not in the supplied material as background knowledge\n" +
              "## The NZ interest - treaty obligations, trade exposure, diaspora, precedent\n" +
              "## Where the Government stands - from the supplied items and context only; if it has not spoken, say so\n" +
              "## Her angle - grounded in the HER POSITIONS context; label judgment as 'Judgment call:'\n" +
              "## Risks - how this could rebound on the opposition\n" +
              "Never invent a government statement, a quote, a number or a date. " +
              "Distinguish reported claims from established facts. No emojis. No em dashes.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
          { type: "text", text: contextBlock(settings) },
        ],
        messages: [{
          role: "user",
          content: "THE STORY (storyline and its coverage):\n" + JSON.stringify(payload) +
            "\n\nWrite the backgrounder.",
        }],
      };
      if (web) body.tools = webTools(model, 8, 6);
      return streamMessage(body, settings.apiKey, onDelta, signal);
    },

    /* Opt-in fact-check of a draft against the desk's own material. No web
       tools by design: this pass verifies against what we hold and can cite,
       not against whatever the open web says today. */
    async verify(draftMd, payload, settings) {
      const body = {
        model: settings.synthModel || settings.model || "claude-opus-5",
        max_tokens: 8000,
        system: [
          { type: "text", text: VERIFY_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
          { type: "text", text: contextBlock(settings) },
        ],
        messages: [{
          role: "user",
          content: "DRAFT TO CHECK:\n" + draftMd + "\n\nDESK MATERIAL:\n" + JSON.stringify(payload),
        }],
        output_config: { format: { type: "json_schema", schema: VERIFY_SCHEMA }, effort: "medium" },
      };
      const data = await createMessage(body, settings.apiKey);
      const block = (data.content || []).find((b) => b.type === "text");
      if (!block) throw new Error("Verification returned no content");
      const parsed = scrubDeep(JSON.parse(block.text));
      parsed._usage = data.usage;
      return parsed;
    },
  };

  window.AI = AI;
})();
