# Throwaway test harness for gate_template.html — delete after use.
# Builds an encrypted fixture set per the crypto contract, serves it over
# localhost HTTP (in-process), and drives the page with Playwright (sync).
import base64
import json
import os
import shutil
import struct
import sys
import threading
import traceback
import zipfile
import hashlib
import unicodedata
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, ".fixture")

TITLE = "The Fixture Chronicles"
SUBTITLE = "A Tiny Book for Testing"
AUTHOR = "Test Author"
WATERMARK = "Early reader copy · {email} · Please don’t share or post."
ITERATIONS = 5000  # low for test speed; page reads this from the manifest
CODES = [
    ("STUDENTS-ALPHA-7", "students"),
    ("FRIENDS-BETA-9", "friends"),
]
EMAIL = "tester@example.com"

LOGS = []  # POSTs received at /log


def b64(b):
    return base64.b64encode(b).decode("ascii")


def normalize(code):
    return unicodedata.normalize("NFC", code).strip().upper()


def encrypt_blob(key, data):
    iv = os.urandom(12)
    return iv + AESGCM(key).encrypt(iv, data, None)


def make_pdf():
    """Minimal valid 1-page PDF, offsets computed exactly."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 24 Tf 72 700 Td (Fixture Book) Tj ET"
    objects.append(
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    )
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(out))
        out += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref_off = len(out)
    n = len(objects) + 1
    out += b"xref\n0 " + str(n).encode() + b"\n"
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += (
        b"trailer\n<< /Size " + str(n).encode() + b" /Root 1 0 R >>\nstartxref\n"
        + str(xref_off).encode() + b"\n%%EOF\n"
    )
    return bytes(out)


def make_html():
    return (
        "<!DOCTYPE html>\n<html><head><meta charset='utf-8'>"
        "<title>Fixture Book</title></head>\n"
        "<body><h1>The Fixture Chronicles</h1><p>Chapter one text.</p></body>\n</html>\n"
    ).encode("utf-8")


def make_epub():
    """Minimal hand-built EPUB with one OEBPS/text/*.xhtml chapter."""
    container = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        "<dc:identifier id=\"uid\">urn:uuid:test-fixture</dc:identifier>"
        "<dc:title>The Fixture Chronicles</dc:title><dc:language>en</dc:language>"
        "</metadata>"
        '<manifest><item id="c1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>'
        "</manifest>"
        '<spine><itemref idref="c1"/></spine></package>'
    )
    chapter = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head>'
        "<body><h1>Chapter 1</h1><p>The chicken crossed the road.</p></body></html>"
    )
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", opf, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/text/chapter1.xhtml", chapter, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def build_fixture():
    if os.path.exists(FIXTURE):
        shutil.rmtree(FIXTURE)
    os.makedirs(FIXTURE)

    K = os.urandom(32)
    codes = []
    for code, label in CODES:
        salt = os.urandom(16)
        kek = hashlib.pbkdf2_hmac("sha256", normalize(code).encode("utf-8"), salt, ITERATIONS, 32)
        iv = os.urandom(12)
        wrapped = AESGCM(kek).encrypt(iv, K, None)
        assert len(wrapped) == 48
        codes.append({"label": label, "salt": b64(salt), "iv": b64(iv), "wrapped": b64(wrapped)})

    artifacts = {"html": make_html(), "pdf": make_pdf(), "epub": make_epub()}
    files = {}
    for kind, data in artifacts.items():
        enc = encrypt_blob(K, data)
        path = kind + ".bin"
        with open(os.path.join(FIXTURE, path), "wb") as f:
            f.write(enc)
        files[kind] = {"path": path, "size": len(enc)}

    manifest = {
        "version": 1,
        "title": TITLE,
        "subtitle": SUBTITLE,
        "author": AUTHOR,
        "generated": "2026-06-10",
        "kdf": {"name": "PBKDF2", "hash": "SHA-256", "iterations": ITERATIONS},
        "codes": codes,
        "files": files,
        "logEndpoint": "/log",
        "watermark": WATERMARK,
    }
    with open(os.path.join(FIXTURE, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    shutil.copy(os.path.join(HERE, "gate_template.html"), os.path.join(FIXTURE, "index.html"))
    shutil.copytree(os.path.join(HERE, "vendor"), os.path.join(FIXTURE, "vendor"))
    return manifest


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=FIXTURE, **kw)

    def do_POST(self):
        if self.path == "/log":
            length = int(self.headers.get("Content-Length", 0))
            try:
                LOGS.append(json.loads(self.rfile.read(length)))
            except Exception:
                LOGS.append({"_parse_error": True})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"{}")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


PASS, FAIL = [], []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("PASS:", name)
    else:
        FAIL.append((name, detail))
        print("FAIL:", name, detail)


def run_browser_tests(port):
    from playwright.sync_api import sync_playwright

    wm_friends = WATERMARK.replace("{email}", EMAIL)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(accept_downloads=True)
        page = ctx.new_page()
        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        page.goto("http://127.0.0.1:%d/" % port)
        page.wait_for_selector("#unlock-section", state="visible", timeout=15000)
        check("manifest load: title shown", page.text_content("#book-title").strip() == TITLE,
              page.text_content("#book-title"))
        check("manifest load: author shown", AUTHOR in page.text_content("#book-author"))
        check("manifest load: subtitle shown", SUBTITLE in page.text_content("#book-subtitle"))

        # ── wrong code rejected ──
        page.fill("#code", "WRONG-CODE-123")
        page.fill("#email", EMAIL)
        page.check("#agree")
        page.click("#unlock-btn")
        page.wait_for_selector("#code-error.show", timeout=30000)
        check("wrong code: error message", "didn't work" in page.text_content("#code-error"))
        check("wrong code: still locked", page.is_hidden("#actions-section"))

        # ── correct code (lowercase + whitespace, tests normalization) ──
        page.fill("#code", "  friends-beta-9  ")
        page.click("#unlock-btn")
        page.wait_for_selector("#actions-section", state="visible", timeout=30000)
        msg = page.text_content("#unlock-message")
        check("unlock: group label NOT shown to reader", "friends" not in msg, msg)
        check("unlock: email in message", EMAIL in msg, msg)

        # ── read online (popup or fallback link) ──
        popup = None
        try:
            with ctx.expect_page(timeout=10000) as pi:
                page.click("#btn-read")
            popup = pi.value
        except Exception:
            if page.is_visible("#fallback-read"):
                with ctx.expect_page(timeout=10000) as pi:
                    page.click("#fallback-read a")
                popup = pi.value
        check("read-online: tab opened", popup is not None)
        if popup:
            popup.wait_for_load_state()
            content = popup.content()
            check("read-online: watermark with email present", wm_friends in content
                  or wm_friends.replace("'", "&apos;") in content, content[:500])
            check("read-online: banner div present", 'id="erc-watermark-banner"' in content)
            check("read-online: book text present", "Chapter one text." in content)
            popup.close()

        # ── PDF download ──
        with page.expect_download(timeout=30000) as di:
            page.click("#btn-pdf")
        dl = di.value
        pdf_path = os.path.join(FIXTURE, "out.pdf")
        dl.save_as(pdf_path)
        pdf_bytes = open(pdf_path, "rb").read()
        check("pdf: filename", dl.suggested_filename == TITLE + " — Early Reader Copy.pdf",
              dl.suggested_filename)
        check("pdf: starts with %PDF", pdf_bytes[:5] == b"%PDF-")
        check("pdf: larger than source (stamp added)", len(pdf_bytes) > 400, str(len(pdf_bytes)))
        # pdf-lib saves with compressed (object) streams; decompress them all
        # and verify the font and the stamped watermark text are really there.
        import re as _re
        import zlib as _zlib
        inflated = b""
        for m in _re.finditer(rb"stream\r?\n", pdf_bytes):
            start = m.end()
            end = pdf_bytes.find(b"endstream", start)
            if end == -1:
                continue
            try:
                inflated += _zlib.decompress(pdf_bytes[start:end].rstrip(b"\r\n"))
            except Exception:
                inflated += pdf_bytes[start:end]
        check("pdf: Helvetica referenced", b"Helvetica" in pdf_bytes + inflated)
        # pdf-lib writes drawText strings as hex-encoded WinAnsi glyph codes
        # (· is 0xB7, ’ is 0x92 in cp1252); search literal and hex forms.
        wm_winansi = wm_friends.encode("cp1252")
        wm_hex = wm_winansi.hex().encode()
        email_hex = EMAIL.encode().hex().encode()
        hay = inflated.lower()
        check("pdf: watermark text stamped in content stream",
              wm_winansi in inflated or wm_hex in hay or email_hex in hay,
              inflated[:200])
        pdf_status = page.text_content("#status-pdf")
        check("pdf: success status", "Done" in pdf_status, pdf_status)

        # ── EPUB download ──
        with page.expect_download(timeout=30000) as di:
            page.click("#btn-epub")
        dl = di.value
        epub_path = os.path.join(FIXTURE, "out.epub")
        dl.save_as(epub_path)
        check("epub: filename", dl.suggested_filename == TITLE + " — Early Reader Copy.epub",
              dl.suggested_filename)
        with zipfile.ZipFile(epub_path) as z:
            names = z.namelist()
            infos = z.infolist()
            check("epub: mimetype first entry", names[0] == "mimetype", str(names))
            check("epub: mimetype stored uncompressed",
                  infos[0].compress_type == zipfile.ZIP_STORED)
            check("epub: mimetype content",
                  z.read("mimetype") == b"application/epub+zip")
            check("epub: META-INF before OEBPS",
                  names.index("META-INF/container.xml") < names.index("OEBPS/content.opf"),
                  str(names))
            ch = z.read("OEBPS/text/chapter1.xhtml").decode("utf-8")
            wm_xml = (wm_friends.replace("&", "&amp;").replace("<", "&lt;")
                      .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;"))
            check("epub: watermark div in chapter", wm_xml in ch and "border-top:1px solid #ccc" in ch,
                  ch[-300:])
            check("epub: watermark before </body>", ch.rfind("</body>") > ch.find("border-top"))
            check("epub: original text intact", "The chicken crossed the road." in ch)

        # ── access logging ──
        actions = [(l.get("action"), l.get("group"), l.get("email")) for l in LOGS]
        check("log: unlock logged", ("unlock", "friends", EMAIL) in actions, str(actions))
        check("log: read-online logged", ("read-online", "friends", EMAIL) in actions, str(actions))
        check("log: download-pdf logged", ("download-pdf", "friends", EMAIL) in actions, str(actions))
        check("log: download-epub logged", ("download-epub", "friends", EMAIL) in actions, str(actions))
        check("log: book title in payload", all(l.get("book") == TITLE for l in LOGS), str(LOGS))

        # ── second code round-trip (students) after reload ──
        page.reload()
        page.wait_for_selector("#unlock-section", state="visible", timeout=15000)
        page.fill("#code", "students-alpha-7")
        page.fill("#email", EMAIL)
        page.check("#agree")
        page.click("#unlock-btn")
        page.wait_for_selector("#actions-section", state="visible", timeout=30000)
        check("unlock: 2nd code unlocks, group label still hidden",
              "students" not in page.text_content("#unlock-message"))
        page.wait_for_timeout(500)  # let the unlock log POST land
        check("log: 2nd code's group identified internally",
              ("unlock", "students", EMAIL) in
              [(l.get("action"), l.get("group"), l.get("email")) for l in LOGS],
              str(LOGS[-3:]))

        real_errors = [e for e in console_errors if "favicon" not in e]
        check("no console/page errors", not real_errors, str(real_errors))

        browser.close()


def main():
    build_fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        run_browser_tests(port)
    finally:
        server.shutdown()
        server.server_close()
    print("\n=== %d passed, %d failed ===" % (len(PASS), len(FAIL)))
    for name, detail in FAIL:
        print("FAILED:", name, "--", detail)
    return 1 if FAIL else 0


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception:
        traceback.print_exc()
    finally:
        # cleanup fixture
        try:
            shutil.rmtree(FIXTURE)
            print("fixture cleaned up")
        except Exception as e:
            print("cleanup failed:", e)
    sys.exit(code)
