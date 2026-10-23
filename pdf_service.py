#!/usr/bin/env python3
"""
pdf_service.py - Local PDF service behind the EntropyEditor's "Generate PDF" picker.

The editor is a static page and cannot run the Python exporter itself, so this
small HTTP service (bound to 127.0.0.1 only) takes the book JSON plus the ticked
section ids from the editor and answers with the PDF that entropy_to_pdf_v2.py
produces: real text, a cover, a contents page with true page numbers, and one
section per page. No print dialog, no printer choice, nothing rasterized.

Usage:
    py pdf_service.py                          # serves http://127.0.0.1:8644
    py pdf_service.py --port 9000
    py pdf_service.py --base-dir "C:\\path\\to\\book"   # folder that image paths in the book are relative to
    (or double-click start_pdf_service.bat)

Leave the window open while editing; Ctrl+C stops it. Requires playwright
(+ chromium) and pymupdf, exactly like the exporter.

Endpoints:
    GET  /health -> {"ok": true, "service": "entropy-pdf", "version": 1}
    POST /pdf    <- {"data": <book json>, "sections": [node ids] | null, "filename": "name.pdf"}
                 -> application/pdf as an attachment, or {"error": "..."} with 400 / 500
"""
import argparse
import json
import re
import sys
import tempfile
import time
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
try:
    import entropy_to_pdf_v2 as exporter
except ImportError as exc:  # pragma: no cover - environment problem, not logic
    print(f"Cannot import entropy_to_pdf_v2.py next to this script: {exc}")
    sys.exit(1)

SERVICE_VERSION = 1
DEFAULT_PORT = 8644
MAX_BODY_BYTES = 256 * 1024 * 1024   # book JSONs run to ~8 MB; leave generous headroom
BASE_DIR = HERE                       # overridden by --base-dir


def safe_filename(name, fallback="book"):
    """A file name Windows and browsers accept: drop path separators and reserved
    characters, collapse whitespace, cap the length, and force a .pdf suffix."""
    text = str(name or "").strip()
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    if text.lower().endswith(".pdf"):
        text = text[:-4].rstrip(" .")
    if not text:
        text = fallback
    return text[:150] + ".pdf"


def content_disposition(filename):
    """RFC 6266 attachment header with an ASCII fallback and a UTF-8 form."""
    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "'")
    utf8_name = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


class Handler(BaseHTTPRequestHandler):
    server_version = "EntropyPDF/1"

    # --- plumbing ---

    def _cors(self):
        # The editor runs from file:// (origin "null") or any local origin; the
        # service only ever binds to loopback, so a wildcard is the right scope.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_pdf(self, pdf_bytes, filename):
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", content_disposition(filename))
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.end_headers()
        self.wfile.write(pdf_bytes)

    def log_message(self, fmt, *args):  # one concise line per request
        sys.stdout.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))
        sys.stdout.flush()

    def _read_json_body(self):
        length = self.headers.get("Content-Length")
        try:
            length = int(length)
        except (TypeError, ValueError):
            raise ValueError("missing or invalid Content-Length")
        if length <= 0:
            raise ValueError("empty request body")
        if length > MAX_BODY_BYTES:
            raise ValueError(f"request body too large ({length} bytes; limit {MAX_BODY_BYTES})")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("request body truncated")
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"body is not valid JSON: {exc}")

    # --- routes ---

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "service": "entropy-pdf", "version": SERVICE_VERSION,
                                            "baseDir": str(BASE_DIR)})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint; use GET /health or POST /pdf"})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path != "/pdf":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint; use POST /pdf"})
            return
        started = time.time()
        try:
            payload = self._read_json_body()
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
            data = payload.get("data")
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), dict) or "root" not in data:
                raise ValueError("'data' must be an Entropy book with nodes and root")
            sections = payload.get("sections")
            if sections is not None and not isinstance(sections, list):
                raise ValueError("'sections' must be a list of node ids or null")
            meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
            filename = safe_filename(payload.get("filename") or meta.get("title") or "book")

            with tempfile.TemporaryDirectory(prefix="entropy-pdf-") as tmp:
                out = Path(tmp) / "out.pdf"
                written = exporter.render_book(
                    data, out, base_dir=BASE_DIR, sections=sections,
                    log=lambda m: self.log_message("%s", str(m).strip()) if str(m).strip() else None)
                pdf_bytes = Path(written).read_bytes()
            if not pdf_bytes.startswith(b"%PDF"):
                raise RuntimeError("exporter produced something that is not a PDF")
            self._send_pdf(pdf_bytes, filename)
            self.log_message("PDF %s  %d bytes  %d section(s)  %.1fs", filename, len(pdf_bytes),
                             len(sections) if sections else len(data["nodes"]), time.time() - started)
        except ValueError as exc:
            self.log_message("rejected: %s", exc)
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # exporter / Playwright failures
            traceback.print_exc()
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"PDF generation failed: {exc}"})


def main(argv=None):
    global BASE_DIR
    ap = argparse.ArgumentParser(description="Local PDF service for the EntropyEditor (127.0.0.1 only).")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})")
    ap.add_argument("--base-dir", default=str(HERE),
                    help="folder that relative image paths in the book resolve against (default: this folder)")
    args = ap.parse_args(argv)

    if not (1 <= args.port <= 65535):
        print(f"Invalid port: {args.port}")
        return 2
    base = Path(args.base_dir).expanduser()
    if not base.is_dir():
        print(f"--base-dir is not a folder: {base}")
        return 2
    BASE_DIR = base.resolve()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as exc:
        print(f"Cannot listen on 127.0.0.1:{args.port} ({exc}). Is another service using that port? Try --port.")
        return 1
    server.daemon_threads = True
    print(f"Entropy PDF service  http://127.0.0.1:{args.port}")
    print(f"  images relative to: {BASE_DIR}")
    print("  In the editor: PDF button -> tick sections -> Generate PDF.  Ctrl+C stops this service.")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nPDF service stopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
