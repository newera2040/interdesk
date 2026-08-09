#!/usr/bin/env python3
"""relay-dev.py - local stand-in for the InterDesk Cloudflare relay (stdlib only).

Same routes, auth, validation and body limits as tools/relay-worker.js, so
the whole pin/note/respond loop can be exercised on one machine
with zero accounts:

    python3 tools/relay-dev.py                # port 8795, dev keys
    python3 tools/relay-dev.py 9000           # custom port
    READ_KEY=r WRITE_KEY=w python3 tools/relay-dev.py --ttl 5   # fast expiry

Serve the app itself on 8793 and run this relay on 8795: the two ports make
every relay call genuinely cross-origin, so CORS preflights and the
Authorization header get exercised exactly as they will against workers.dev.
--ttl N overrides every namespace TTL to N seconds for expiry testing.
In-memory only: restarting clears everything, which is fine for a dev tool.
"""
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DAY = 86400
PORT = 8795
READ_KEY = os.environ.get("READ_KEY", "reader-dev")
WRITE_KEY = os.environ.get("WRITE_KEY", "writer-dev")
TTL_OVERRIDE = None

_args = sys.argv[1:]
_i = 0
while _i < len(_args):
    if _args[_i] == "--ttl" and _i + 1 < len(_args):
        TTL_OVERRIDE = int(_args[_i + 1])
        _i += 2
    elif _args[_i].isdigit():
        PORT = int(_args[_i])
        _i += 1
    else:
        _i += 1

# Mirrors the worker's NS table: prefix, id regex, body cap, id field that
# must match the path, string field that must be a string ("bad record").
NS = {
    "pins":     ("pin:",  re.compile(r"^i[a-z0-9]{1,20}$"),    4096, "itemId", "title"),
    "notes":    ("note:", re.compile(r"^i[a-z0-9]{1,20}$"),    2048, "itemId", "text"),
    "respond":  ("resp:", re.compile(r"^i[a-z0-9]{1,20}$"), 2048, "itemId", None),
}
ROUTE_RE = re.compile(r"^/(pins|notes|respond)/([a-z0-9]+)$")

STORE = {}  # key ("pin:i...", "cap:c...", "meta:desk") -> (expires_at, blob)

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
}


def ttl_for(seg, body):
    if TTL_OVERRIDE is not None:
        return TTL_OVERRIDE
    if seg == "pins":
        t = body.get("ttlSeconds")
        if isinstance(t, (int, float)) and not isinstance(t, bool):
            return min(30 * DAY, max(3600, int(t)))
        return 7 * DAY
    if seg == "meta":
        return 30 * DAY
    return 60 * DAY  # notes and respond; respond renews on every re-PUT


def purge():
    now = time.time()
    for k in [k for k, (exp, _) in STORE.items() if exp < now]:
        del STORE[k]


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _auth(self):
        """Return "write", "read" or None. WRITE_KEY may do everything."""
        a = self.headers.get("Authorization", "")
        if a == "Bearer " + WRITE_KEY:
            return "write"
        if a == "Bearer " + READ_KEY:
            return "read"
        return None

    def _route(self):
        """-> (segment, store_key, max_bytes, id_field, str_field) or None."""
        path = self.path.split("?", 1)[0].rstrip("/")
        if path == "/meta/desk":
            return ("meta", "meta:desk", 1024, None, None)
        if path == "/desk":
            return ("desk", "deskpage:current", 32768, None, "html")
        m = ROUTE_RE.match(path)
        if not m:
            return None
        prefix, id_re, max_len, id_field, str_field = NS[m.group(1)]
        if not id_re.match(m.group(2)):
            return None
        return (m.group(1), prefix + m.group(2), max_len, id_field, str_field)

    def do_OPTIONS(self):
        self._send(204)

    def do_GET(self):
        path = self.path.split("?", 1)[0].rstrip("/")
        # Public time beacon — mirrors the worker's /time: clock only, no auth.
        if path == "/time":
            return self._send(200, {"now": int(time.time() * 1000)})
        if not self._auth():
            return self._send(401, {"error": "unauthorized"})
        purge()
        if path == "/state":
            state = {
                "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "pins": [], "notes": [], "responds": [], "meta": None, "desk": None,
            }
            for key, (_, blob) in STORE.items():
                if key.startswith("pin:"):
                    state["pins"].append(blob)
                elif key.startswith("note:"):
                    state["notes"].append(blob)
                elif key.startswith("resp:"):
                    state["responds"].append(blob)
                elif key == "meta:desk":
                    state["meta"] = blob
                elif key == "deskpage:current":
                    state["desk"] = blob
            return self._send(200, state)
        self._send(404, {"error": "not found"})

    def do_PUT(self):
        if self._auth() != "write":
            return self._send(401, {"error": "unauthorized"})
        r = self._route()
        if not r:
            return self._send(404, {"error": "not found"})
        seg, key, max_len, id_field, str_field = r
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        if len(raw) > max_len:
            return self._send(413, {"error": "too big"})
        try:
            body = json.loads(raw)
        except ValueError:
            return self._send(400, {"error": "bad json"})
        rec_id = key.split(":", 1)[1]
        if (not isinstance(body, dict)
                or (id_field and body.get(id_field) != rec_id)
                or (str_field and not isinstance(body.get(str_field), str))):
            return self._send(400, {"error": "bad record"})
        STORE[key] = (time.time() + ttl_for(seg, body), body)
        self._send(200, {"ok": True})

    def do_DELETE(self):
        if self._auth() != "write":
            return self._send(401, {"error": "unauthorized"})
        r = self._route()
        if not r:
            return self._send(404, {"error": "not found"})
        STORE.pop(r[1], None)
        self._send(200, {"ok": True})

    def log_message(self, fmt, *args):
        sys.stderr.write("relay %s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    print(f"InterDesk relay on http://localhost:{PORT}", flush=True)
    print(f"  READ_KEY={READ_KEY!r}  WRITE_KEY={WRITE_KEY!r}"
          + (f"  ttl override={TTL_OVERRIDE}s" if TTL_OVERRIDE is not None else ""),
          flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
