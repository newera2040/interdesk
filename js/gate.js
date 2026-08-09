/* gate.js — InterDesk front door.
   A 4-digit PIN screen, checked entirely client-side against a salted hash.

   HONESTY, up front: this is a privacy screen, not content security. The site
   is public static hosting; anyone technical can read this file, see the hash,
   and enumerate all 10,000 PINs in milliseconds. The salt only keeps the
   plaintext out of the repo and out of hash-lookup tables. What the gate is
   FOR: shoulder-surfing, a borrowed or unattended phone, casual discovery of
   the URL. What actually protects content: the relay bearer tokens (server-
   verified, rotatable) and the device passcode. If a phone is lost, rotate
   the relay tokens first and worry about the PIN never.

   The app boots BEHIND the gate (opaque fixed layer over an inert #shell), so
   a correct PIN is a ~300ms reveal with zero load wait. Pre-auth DOM exists
   behind the layer — acceptable under the threat model above, and invisible
   to assistive tech because #shell carries `inert` while locked.

   This script is loaded synchronously in <head>, before first paint, so an
   already-unlocked open never flashes the lock screen. It must not touch
   IndexedDB (not open yet); its settings mirror lives in localStorage. */
(function () {
  "use strict";

  var SALT = "interdesk.gate.v1|";
  var EXPECTED = "52797d415b4b90389535ce5d08c15bd9e920d730693c9b23f1cddc2e9b7323c9";
  var PIN_LEN = 4;
  var MAX_FAILS = 5;
  var COOLDOWN_MS = 30000;

  var K_AT = "interdesk.gate.at";        // last-seen stamp (localStorage)
  var K_MODE = "interdesk.gate.mode";    // "open" | "1h" | "24h" (mirrored from settings)
  var K_SESSION = "interdesk.gate.session"; // sessionStorage flag for "open" mode
  var K_FAILS = "interdesk.gate.fails";
  var K_COOL = "interdesk.gate.cooldownUntil";

  var WINDOWS = { open: 0, "1h": 3600000, "24h": 86400000 };

  /* Every storage access is wrapped: private browsing must degrade to
     "prompt every open", never throw. */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* degrade */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* degrade */ } }

  function mode() {
    var m = lsGet(K_MODE);
    return WINDOWS.hasOwnProperty(m) ? m : "1h";
  }

  function withinWindow() {
    var m = mode();
    if (m === "open") return ssGet(K_SESSION) === "1";
    var at = Number(lsGet(K_AT) || 0);
    return at > 0 && Date.now() - at < WINDOWS[m];
  }

  function stamp() {
    lsSet(K_AT, String(Date.now()));
    if (mode() === "open") ssSet(K_SESSION, "1");
  }

  /* --- SHA-256: crypto.subtle with a compact synchronous fallback for
     non-secure dev contexts (GitHub Pages and localhost are both secure). --- */
  function sha256hex(str) {
    if (window.crypto && crypto.subtle && window.isSecureContext) {
      var buf = new TextEncoder().encode(str);
      return crypto.subtle.digest("SHA-256", buf).then(function (h) {
        return Array.from(new Uint8Array(h)).map(function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
      });
    }
    return Promise.resolve(sha256sync(str));
  }

  /* Public-domain-style compact SHA-256 (fallback only). */
  function sha256sync(ascii) {
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var mathPow = Math.pow, maxWord = mathPow(2, 32), result = "";
    var words = [], asciiBitLength = ascii.length * 8;
    var hash = [], k = [], primeCounter = 0;
    var isComposite = {}, candidate, i, j;
    for (candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    ascii += "\x80";
    while ((ascii.length % 64) - 56) ascii += "\x00";
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return ""; // ASCII only — PIN digits always are
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, (j += 16)), oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var a = hash[0], e = hash[4];
        var temp1 = hash[7]
          + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25))
          + ((e & hash[5]) ^ (~e & hash[6])) + k[i]
          + (w[i] = i < 16 ? w[i] : (w[i - 16]
            + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? "0" : "") + b.toString(16);
      }
    }
    return result;
  }

  /* --- State --- */
  var buffer = "";
  var busy = false;
  var wired = false;
  var unlocked = false;
  var coolTimer = null;

  var els = {}; // gate, status, dots, pad — resolved on DOMContentLoaded

  function grab() {
    els.gate = document.getElementById("gate");
    els.status = document.getElementById("gate-status");
    els.dots = document.getElementById("gate-dots");
    els.pad = document.getElementById("gate-pad");
    return !!(els.gate && els.status && els.dots && els.pad);
  }

  function setStatus(text, isErr) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.classList.toggle("err", !!isErr);
  }

  function paintDots() {
    if (!els.dots) return;
    var kids = els.dots.children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i < buffer.length);
  }

  function reveal() {
    document.body.classList.remove("locked");
    var shell = document.getElementById("shell");
    if (shell) shell.removeAttribute("inert");
    unlocked = true;
    window.Gate = window.Gate || {};
    window.Gate.unlocked = true;
    document.dispatchEvent(new CustomEvent("interdesk:unlocked"));
  }

  function passThrough() {
    // Already inside the window: no gate, no wiring, instant app.
    if (els.gate) els.gate.setAttribute("hidden", "");
    reveal();
  }

  function unlock() {
    stamp();
    lsSet(K_FAILS, "0");
    if (els.dots) els.dots.classList.add("ok");
    setStatus("");
    var gate = els.gate;
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      gate.setAttribute("hidden", "");
      gate.classList.remove("away");
      if (els.dots) els.dots.classList.remove("ok");
      buffer = "";
      paintDots();
      busy = false;
    };
    reveal();
    setTimeout(function () {
      gate.classList.add("away");
      gate.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 400); // safety net if transitionend never fires
    }, 60);
  }

  function fail() {
    var fails = Number(lsGet(K_FAILS) || 0) + 1;
    lsSet(K_FAILS, String(fails));
    if (els.dots) {
      els.dots.classList.add("err", "shake");
      setTimeout(function () { els.dots.classList.remove("shake"); }, 340);
    }
    if (navigator.vibrate) { try { navigator.vibrate([60, 40, 60]); } catch (e) { /* no-op */ } }
    setTimeout(function () {
      buffer = "";
      paintDots();
      if (els.dots) els.dots.classList.remove("err");
      if (fails >= MAX_FAILS) {
        startCooldown(Date.now() + COOLDOWN_MS);
      } else {
        setStatus("Incorrect PIN", true);
        setTimeout(function () { if (!busy) setStatus("Enter PIN"); }, 1200);
        busy = false;
      }
    }, 450);
  }

  /* Cooldown: a speed bump for a person holding the phone, nothing more —
     clearing storage or fetching the site raw bypasses it, which is fine
     under the threat model. Never a permanent lockout. */
  function startCooldown(until) {
    lsSet(K_COOL, String(until));
    setPadDisabled(true);
    busy = true;
    var tick = function () {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(coolTimer);
        coolTimer = null;
        lsSet(K_FAILS, "0");
        lsSet(K_COOL, "0");
        setPadDisabled(false);
        busy = false;
        setStatus("Enter PIN");
        return;
      }
      setStatus("Try again in " + left + " s", true);
    };
    tick();
    coolTimer = setInterval(tick, 1000);
  }

  function setPadDisabled(dis) {
    if (!els.pad) return;
    var keys = els.pad.querySelectorAll(".gate-key");
    for (var i = 0; i < keys.length; i++) keys[i].disabled = dis;
  }

  function check() {
    busy = true;
    sha256hex(SALT + buffer).then(function (hex) {
      if ((hex || "").toLowerCase() === EXPECTED) unlock();
      else fail();
    }).catch(function () {
      // Hashing itself failed (ancient browser): fail open would defeat the
      // point; fail with a message instead.
      setStatus("Browser not supported", true);
      busy = false;
      buffer = "";
      paintDots();
    });
  }

  function input(k) {
    if (busy || unlocked) return;
    if (k === "del") {
      buffer = buffer.slice(0, -1);
      paintDots();
      return;
    }
    if (!/^[0-9]$/.test(k) || buffer.length >= PIN_LEN) return;
    buffer += k;
    paintDots();
    if (buffer.length === PIN_LEN) setTimeout(check, 120); // let the 4th dot land
  }

  function wire() {
    if (wired) return;
    wired = true;

    // Pointer input, delegated; isPrimary guards multi-touch double entry.
    els.pad.addEventListener("pointerdown", function (e) {
      if (!e.isPrimary) return;
      var key = e.target.closest(".gate-key");
      if (!key || key.disabled) return;
      key.classList.add("pressed");
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* no-op */ } }
      input(key.dataset.k);
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      els.pad.addEventListener(ev, function (e) {
        var key = e.target.closest(".gate-key");
        if (key) key.classList.remove("pressed");
      }, true);
    });

    // Desktop keyboard path — works regardless of focus position.
    document.addEventListener("keydown", function (e) {
      if (unlocked || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) { input(e.key); e.preventDefault(); }
      else if (e.key === "Backspace") { input("del"); e.preventDefault(); }
      else if (e.key === "Escape") { buffer = ""; paintDots(); }
    });

    // Resume an in-flight cooldown across a reflexive reload.
    var coolUntil = Number(lsGet(K_COOL) || 0);
    if (coolUntil > Date.now()) startCooldown(coolUntil);

    // Desktop nicety: focus pad centre so arrowing/tabbing starts sensibly.
    if (matchMedia("(hover: hover)").matches) {
      var five = els.pad.querySelector('[data-k="5"]');
      if (five) five.focus();
    }
  }

  function relock() {
    if (!els.gate) return;
    unlocked = false;
    if (window.Gate) window.Gate.unlocked = false;
    buffer = "";
    busy = false;
    paintDots();
    setStatus("Enter PIN");
    els.gate.classList.remove("away");
    els.gate.removeAttribute("hidden");
    document.body.classList.add("locked");
    var shell = document.getElementById("shell");
    if (shell) shell.setAttribute("inert", "");
    wire();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") {
      if (unlocked) stamp();
    } else if (document.visibilityState === "visible") {
      if (unlocked && !withinWindow()) relock();
    }
  }

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", function () { if (unlocked) stamp(); });

  document.addEventListener("DOMContentLoaded", function () {
    if (!grab()) { // markup missing — fail closed is impossible, so fail open loudly
      document.body.classList.remove("locked");
      return;
    }
    if (withinWindow()) {
      passThrough();
    } else {
      wire();
    }
  });

  window.Gate = {
    unlocked: false,
    /* Settings writes call this so the gate can read policy synchronously
       next boot. */
    setMode: function (m) {
      if (WINDOWS.hasOwnProperty(m)) lsSet(K_MODE, m);
    },
    mode: mode,
    lock: relock,
  };
})();
