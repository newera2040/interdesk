/* relay.js — client for the InterDesk relay (tools/relay-worker.js).

   The relay is the desk's shared surface: pins, notes and respond flags
   travel desk -> phone in one GET /state. Two keys: the read key can only
   read, the desk key can also write, so the reader's phone carries the
   cheap key.

   Config is injected by the app whenever settings load or change —
   Relay.configure({url, readKey, deskKey}). The keys live in the app's
   IndexedDB settings; this module only holds them in memory.

   Everything here throws on failure; callers toast and carry on. A relay
   problem must never break a sweep or a render. */
(function () {
  let cfg = { url: "", readKey: "", deskKey: "" };

  function base() {
    return String(cfg.url || "").replace(/\/+$/, "");
  }

  function readAuth() {
    return cfg.readKey || cfg.deskKey || ""; // reads prefer the read key
  }

  function writeAuth() {
    if (!cfg.deskKey) throw new Error("Desk key not set");
    return cfg.deskKey;
  }

  async function request(path, { method = "GET", body = null, key = "" } = {}) {
    if (!base()) throw new Error("Relay URL not set");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(base() + path, {
        method,
        signal: ctrl.signal,
        headers: {
          "Authorization": "Bearer " + key,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401) throw new Error("relay rejected the key");
      if (!res.ok) throw new Error("relay HTTP " + res.status);
      return res.json();
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("relay timed out (10s)");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // async so a missing desk key rejects the returned promise, never throws
  // synchronously — callers always .catch() one way.
  const get = async (path) => request(path, { key: readAuth() });
  const put = async (path, body) => request(path, { method: "PUT", body, key: writeAuth() });
  const del = async (path) => request(path, { method: "DELETE", key: writeAuth() });

  const Relay = {
    configure({ url = "", readKey = "", deskKey = "" } = {}) {
      cfg = { url: url || "", readKey: readKey || "", deskKey: deskKey || "" };
    },

    enabled() {
      return Boolean(base() && readAuth());
    },

    canWrite() {
      return Boolean(cfg.deskKey);
    },

    /* -> {generated, pins, notes, responds, meta} */
    state() {
      return get("/state");
    },


    putPin(pin, ttlSeconds) {
      const body = ttlSeconds == null ? pin : { ...pin, ttlSeconds };
      return put("/pins/" + encodeURIComponent(pin.itemId), body);
    },
    delPin(id) {
      return del("/pins/" + encodeURIComponent(id));
    },

    putNote(note) {
      return put("/notes/" + encodeURIComponent(note.itemId), note);
    },
    delNote(id) {
      return del("/notes/" + encodeURIComponent(id));
    },


    putRespond(flag) {
      return put("/respond/" + encodeURIComponent(flag.itemId), flag);
    },
    delRespond(id) {
      return del("/respond/" + encodeURIComponent(id));
    },

    /* The shipped desk page: {md, title, date, shippedAt} */
    putDesk(desk) {
      return put("/desk", desk);
    },
    delDesk() {
      return del("/desk");
    },
    putMeta(meta) {
      return put("/meta/desk", meta);
    },
  };

  window.Relay = Relay;
})();
