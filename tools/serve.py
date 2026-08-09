#!/usr/bin/env python3
"""Dev server for InterDesk.

Identical to `python3 -m http.server` except it sends no-store headers, so an
edited js/css file is always re-fetched. Plain http.server sends no
Cache-Control at all, which lets browsers cache heuristically and silently
serve a stale ui.js after an edit.

Port resolution, in order: the PORT environment variable (set by the preview
harness when it assigns a port), then a numeric argument, then 8793. The
directory defaults to the interdesk folder next to this script.

Usage: python3 tools/serve.py [port] [directory]
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_PORT = 8793
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Keep the console readable: only surface errors.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)


def resolve():
    """PORT env wins so the harness can assign a free port; args are a fallback."""
    args = sys.argv[1:]
    port = next((int(a) for a in args if a.isdigit()), DEFAULT_PORT)
    directory = next((a for a in args if not a.isdigit()), APP_DIR)
    env_port = os.environ.get("PORT")
    if env_port and env_port.isdigit():
        port = int(env_port)
    if not os.path.isabs(directory):
        directory = os.path.abspath(directory)
    return port, directory


def main():
    port, directory = resolve()
    handler = functools.partial(NoCacheHandler, directory=directory)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"InterDesk serving {directory} at http://localhost:{port} (no-store)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
