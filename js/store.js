/* store.js — IndexedDB persistence for InterDesk.
   Stores: items (wire), storylines, briefs, saved (snapshotted items),
   highlights (her marked lines), kv (settings + metadata). */
(function () {
  const DB_NAME = "interdesk";
  const DB_VERSION = 1;
  const MAX_ITEMS = 8000;

  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("items")) {
          const s = db.createObjectStore("items", { keyPath: "id" });
          s.createIndex("published", "published");
          s.createIndex("storyId", "storyId");
        }
        if (!db.objectStoreNames.contains("storylines")) {
          const s = db.createObjectStore("storylines", { keyPath: "id" });
          s.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("briefs")) {
          db.createObjectStore("briefs", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("saved")) {
          db.createObjectStore("saved", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("highlights")) {
          const s = db.createObjectStore("highlights", { keyPath: "id" });
          s.createIndex("refId", "refId");
        }
        if (!db.objectStoreNames.contains("kv")) {
          db.createObjectStore("kv", { keyPath: "key" });
        }
      };
      let settled = false;
      // A tab still running the old DB version blocks the upgrade; fail fast
      // with a clear message instead of hanging forever.
      req.onblocked = () => {
        if (!settled) { settled = true; dbPromise = null; reject(new Error("Storage upgrade blocked: close other InterDesk tabs and reload.")); }
      };
      req.onsuccess = () => {
        const db = req.result;
        // If a newer version opens in another tab, step aside so it can
        // upgrade, and tell the reader now rather than letting the next
        // write fail with a cryptic toast.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
          if (window.UI && UI.toast) UI.toast("A newer InterDesk opened in another tab. Reload this one to continue.", 60000);
        };
        if (settled) { db.close(); return; }
        settled = true;
        resolve(db);
      };
      req.onerror = () => {
        if (settled) return;
        settled = true;
        dbPromise = null;
        // A stepped-aside tab reopens at the old version and gets VersionError;
        // translate it into the action the reader actually needs to take.
        const err = req.error && req.error.name === "VersionError"
          ? new Error("This tab is running an older InterDesk. Reload to continue.")
          : req.error;
        reject(err);
      };
    });
    return dbPromise;
  }

  function tx(storeName, mode, fn) {
    return openDB().then(
      (db) =>
        new Promise((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const store = t.objectStore(storeName);
          const out = fn(store);
          t.oncomplete = () => resolve(out && out.__result !== undefined ? out.__result : out);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error);
        })
    );
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const Store = {
    async getAll(storeName) {
      const db = await openDB();
      return reqToPromise(db.transaction(storeName).objectStore(storeName).getAll());
    },

    async get(storeName, key) {
      const db = await openDB();
      return reqToPromise(db.transaction(storeName).objectStore(storeName).get(key));
    },

    async put(storeName, obj) {
      return tx(storeName, "readwrite", (s) => { s.put(obj); });
    },

    async putMany(storeName, objs) {
      if (!objs.length) return;
      return tx(storeName, "readwrite", (s) => { objs.forEach((o) => s.put(o)); });
    },

    async delete(storeName, key) {
      return tx(storeName, "readwrite", (s) => { s.delete(key); });
    },

    async clear(storeName) {
      return tx(storeName, "readwrite", (s) => { s.clear(); });
    },

    async count(storeName) {
      const db = await openDB();
      return reqToPromise(db.transaction(storeName).objectStore(storeName).count());
    },

    /* kv helpers */
    async kvGet(key, fallback) {
      const row = await Store.get("kv", key);
      return row ? row.value : fallback;
    },
    async kvSet(key, value) {
      return Store.put("kv", { key, value });
    },

    /* Prune the wire to MAX_ITEMS, keeping the newest. Items attached to a
       storyline are kept regardless (they're part of the record). */
    async pruneItems() {
      const all = await Store.getAll("items");
      if (all.length <= MAX_ITEMS) return 0;
      const loose = all.filter((i) => !i.storyId).sort((a, b) => a.published - b.published);
      const excess = all.length - MAX_ITEMS;
      const toDrop = loose.slice(0, excess);
      await tx("items", "readwrite", (s) => { toDrop.forEach((i) => s.delete(i.id)); });
      return toDrop.length;
    },

    /* Saved items and highlights are the reader's own work; they survive an
       archive wipe. */
    async wipeAll() {
      await Promise.all(["items", "storylines", "briefs"].map((s) => Store.clear(s)));
    },

    async exportAll() {
      const [items, storylines, briefs, saved, highlights, kv] = await Promise.all([
        Store.getAll("items"), Store.getAll("storylines"), Store.getAll("briefs"),
        Store.getAll("saved"), Store.getAll("highlights"), Store.getAll("kv"),
      ]);
      // Settings travel WITHOUT credentials: the API key and the relay
      // URL/keys never leave this browser in either direction (importAll
      // strips them again on the way in). Export files get messaged around.
      const safeKv = kv.map((r) => r.key === "settings"
        ? { key: r.key, value: { ...r.value, apiKey: "", relayUrl: "", relayKey: "", deskKey: "" } }
        : r);
      return { schema: 1, app: "interdesk", exportedAt: new Date().toISOString(), items, storylines, briefs, saved, highlights, kv: safeKv };
    },

    /* Restore an export. put() merges by id, so re-importing your own backup
       is idempotent and an import never deletes anything. Returns per-store
       counts plus the imported settings value (minus any credentials) so the
       app can merge it without ever letting a file supply a key. */
    async importAll(data) {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Not an InterDesk archive file.");
      if (data.schema && data.schema > 1) throw new Error("This archive was exported by a newer InterDesk. Update this app first.");
      const rows = (v) => (Array.isArray(v) ? v.filter((r) => r && typeof r === "object" && r.id) : []);
      const items = rows(data.items);
      const storylines = rows(data.storylines);
      const briefs = rows(data.briefs);
      const saved = rows(data.saved);
      const highlights = rows(data.highlights);
      const kvRows = Array.isArray(data.kv) ? data.kv.filter((r) => r && typeof r === "object" && r.key) : [];
      if (!items.length && !storylines.length && !briefs.length && !saved.length && !highlights.length && !kvRows.length) {
        throw new Error("Nothing recognisable in this file.");
      }

      let settings = null;
      const safeKv = [];
      for (const r of kvRows) {
        if (r.key === "settings") {
          // The settings row is returned to the caller, never written directly:
          // the app merges it over defaults and keeps the browser's own
          // credentials (API key and relay URL/keys).
          settings = { ...(r.value || {}) };
          delete settings.apiKey;
          delete settings.relayUrl;
          delete settings.relayKey;
          delete settings.deskKey;
        } else if (["readState", "muted", "lastVisit", "seenPins", "seenDeskShippedAt", "corpusMeta", "corpusLive", "lastSweep", "deskDraft"].indexOf(r.key) >= 0) {
          // Allowlist: an archive file must not be able to plant arbitrary
          // kv rows (future keys could be trusted by code that assumes only
          // the app writes them).
          safeKv.push(r);
        }
      }

      await Store.putMany("items", items);
      await Store.putMany("storylines", storylines);
      await Store.putMany("briefs", briefs);
      await Store.putMany("saved", saved);
      await Store.putMany("highlights", highlights);
      await Store.putMany("kv", safeKv);
      return {
        items: items.length, storylines: storylines.length, briefs: briefs.length,
        saved: saved.length, highlights: highlights.length, settings,
      };
    },
  };

  window.Store = Store;
})();
