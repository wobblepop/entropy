#!/usr/bin/env python3
"""
test_e2e_multi.py - End-to-end test of the MULTI-EDITION reader gate
(gate_template_multi.html + build_chickenwhispering_multi.py).

It builds two THROWAWAY encrypted bundles with TEST codes and deliberately
distinct content, assembles them with the real assembler, serves the result on
localhost, and drives the full reader flow with Playwright:

  1. manifests for both editions load; title shown
  2. wrong code is rejected, page stays locked
  3. correct code (lowercase + padding -> exercises normalization) unlocks once
  4. the edition toggle shows BOTH editions; default = "appropriate"
  5. "Read online" on the default edition shows the appropriate edition's content
     + the reader's email watermark
  6. switching the toggle to "unhinged" and reading shows the OTHER edition's
     content (proves the toggle re-points decryption at the right bundle)
  7. PDF download for the selected edition is stamped with the email on pages
  8. EPUB download: mimetype first+stored, watermark in chapters, still valid XML
  9. access-log POSTs carry the correct `edition` field per edition
 10. no console / page errors

No real book content is used; throwaway artifacts are tiny and discarded.

Usage:
    py reader_gate/test_e2e_multi.py
"""

import io
import json
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTROPY = HERE.parent
sys.path.insert(0, str(ENTROPY))

import build_reader_gate as brg                      # noqa: E402
import build_chickenwhispering_multi as multi        # noqa: E402

EMAIL = "early.reader@example.com"
CODE = "TEST-CODE-ALPHA"
CODE2 = "TEST-CODE-BETA"
LOG_URL = "https://example.test/log-sink"

# Distinct, unmistakable per-edition content markers.
MARK_APP = "SORTA-APPROPRIATE-CONTENT-MARKER"
MARK_UNH = "UNHINGED-CONTENT-MARKER"

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f" -- {detail}" if detail else ""))
    if ok:
        PASS += 1
    else:
        FAIL += 1


# ---------------------------------------------------------------------------
# Tiny artifact builders
# ---------------------------------------------------------------------------
def make_html(marker):
    return (
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<title>Chicken Whispering</title></head><body>"
        "<h1>Chicken Whispering</h1><p>" + marker + "</p>"
        "</body></html>"
    ).encode("utf-8")


def make_pdf(marker):
    import fitz
    doc = fitz.open()
    for i in range(3):
        page = doc.new_page()
        page.insert_text((72, 72), f"Chicken Whispering\n{marker}\npage {i + 1}", fontsize=11)
    data = doc.tobytes()
    doc.close()
    return data


def make_epub(marker):
    container = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
        '<rootfiles><rootfile full-path="OEBPS/content.opf" '
        'media-type="application/oebps-package+xml"/></rootfiles></container>'
    )
    opf = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
        '<dc:identifier id="bid">urn:uuid:test</dc:identifier>'
        '<dc:title>Chicken Whispering</dc:title><dc:language>en</dc:language></metadata>'
        '<manifest><item id="c1" href="text/chap1.xhtml" media-type="application/xhtml+xml"/>'
        '<item id="c2" href="text/chap2.xhtml" media-type="application/xhtml+xml"/></manifest>'
        '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
    )

    def chapter(n):
        return (
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter</title></head>'
            f'<body><h2>Chapter {n}</h2><p>{marker}</p></body></html>'
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        zi = zipfile.ZipInfo("mimetype")
        z.writestr(zi, "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", container)
        z.writestr("OEBPS/content.opf", opf)
        z.writestr("OEBPS/text/chap1.xhtml", chapter(1))
        z.writestr("OEBPS/text/chap2.xhtml", chapter(2))
    return buf.getvalue()


def build_bundle(out_dir, marker, codes):
    """Build one encrypted bundle via brg.build(..., reuse=True) with tiny artifacts."""
    out_dir.mkdir(parents=True, exist_ok=True)
    src = out_dir / "src"
    src.mkdir(exist_ok=True)
    stem = "book"
    book_json = src / f"{stem}.json"
    book_json.write_text(json.dumps({"meta": {
        "title": "Chicken Whispering",
        "subtitle": "A smart, dumb, and maybe insane guide.",
        "author": "Scott DuHadway",
        "modified": "2026-06-20T00:00:00Z",
    }, "nodes": []}), encoding="utf-8")
    (src / f"{stem}.html").write_bytes(make_html(marker))
    (src / f"{stem}.pdf").write_bytes(make_pdf(marker))
    (src / f"{stem}.epub").write_bytes(make_epub(marker))

    dist = out_dir / "dist"
    brg.build(book_json, codes, dist, LOG_URL, brg.DEFAULT_WATERMARK, reuse=True)
    return dist


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    import tempfile
    work = Path(tempfile.mkdtemp(prefix="cw_multi_test_"))
    codes = brg.parse_codes([f"group1={CODE}", f"group2={CODE2}"])

    print("Building throwaway bundles + assembling multi-edition gate ...")
    app_dist = build_bundle(work / "appropriate", MARK_APP, codes)
    unh_dist = build_bundle(work / "unhinged", MARK_UNH, codes)
    multi_out = work / "multi"
    multi.assemble(app_dist, unh_dist, multi_out)

    # Structural sanity before the browser test.
    check("root index.html exists", (multi_out / "index.html").exists())
    check("appropriate bundle present",
          (multi_out / "appropriate" / "manifest.json").exists()
          and (multi_out / "appropriate" / "html.bin").exists())
    check("unhinged bundle present",
          (multi_out / "unhinged" / "manifest.json").exists()
          and (multi_out / "unhinged" / "html.bin").exists())

    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", str(multi_out)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/"
    time.sleep(1.0)

    log_posts = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(accept_downloads=True)
            page = ctx.new_page()
            console_errors = []
            page.on("pageerror", lambda e: console_errors.append(str(e)))
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            # Capture access-log POSTs and short-circuit them with a 200.
            def handle_log(route):
                try:
                    body = route.request.post_data
                    if body:
                        log_posts.append(json.loads(body))
                except Exception:
                    pass
                route.fulfill(status=200, content_type="application/json", body="{}")
            page.route("**/log-sink", handle_log)

            page.goto(url, wait_until="networkidle")
            title = page.locator("#book-title").inner_text(timeout=10000)
            check("manifests loaded, title shown", "Chicken Whispering" in title, title)

            # --- wrong code rejected ---
            page.fill("#code", "DEFINITELY-WRONG-CODE")
            page.fill("#email", EMAIL)
            page.check("#agree")
            page.click("#unlock-btn")
            page.wait_for_function(
                "() => document.body.innerText.toLowerCase().includes(\"didn't work\")"
                " || document.body.innerText.toLowerCase().includes('didn\\u2019t work')",
                timeout=120000)
            check("wrong code rejected", page.locator("#actions-section").is_hidden())

            # --- correct code unlocks (normalized: lowercase + whitespace) ---
            page.fill("#code", "  " + CODE.lower() + "  ")
            page.click("#unlock-btn")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            check("correct code unlocks (normalized)", True)

            # --- toggle shows both editions, default = appropriate ---
            check("edition toggle visible", page.locator("#edition-toggle").is_visible())
            check("appropriate radio present + checked",
                  page.locator("#edition-appropriate").is_checked())
            check("unhinged radio present + not checked",
                  not page.locator("#edition-unhinged").is_checked())

            # --- read default (appropriate) edition ---
            with ctx.expect_page(timeout=180000) as pi:
                page.click("#btn-read")
            bp = pi.value
            bp.wait_for_load_state("domcontentloaded", timeout=180000)
            bp.wait_for_selector("#erc-watermark-banner", timeout=60000)
            body_app = bp.locator("body").inner_text()
            banner_app = bp.locator("#erc-watermark-banner").inner_text()
            check("appropriate content shown when appropriate selected",
                  MARK_APP in body_app and MARK_UNH not in body_app)
            check("appropriate HTML watermark has email", EMAIL in banner_app)
            bp.close()

            # --- switch to unhinged and read ---
            page.check("#edition-unhinged")
            check("unhinged now selected", page.locator("#edition-unhinged").is_checked())
            with ctx.expect_page(timeout=180000) as pi2:
                page.click("#btn-read")
            bp2 = pi2.value
            bp2.wait_for_load_state("domcontentloaded", timeout=180000)
            bp2.wait_for_selector("#erc-watermark-banner", timeout=60000)
            body_unh = bp2.locator("body").inner_text()
            check("unhinged content shown after toggle",
                  MARK_UNH in body_unh and MARK_APP not in body_unh)
            bp2.close()

            # --- PDF download for the currently selected (unhinged) edition ---
            with page.expect_download(timeout=600000) as di:
                page.click("#btn-pdf")
            dl = di.value
            pdf_path = work / "out.pdf"
            dl.save_as(pdf_path)
            import fitz
            doc = fitz.open(str(pdf_path))
            n_pages = doc.page_count
            texts = [doc[i].get_text() for i in range(n_pages)]
            doc.close()
            joined = "\n".join(texts)
            check("PDF has email watermark on pages", bool(texts) and all(EMAIL in t for t in texts),
                  f"{n_pages} pages")
            check("PDF is the unhinged edition", MARK_UNH in joined and MARK_APP not in joined)
            check("PDF filename names the edition", "Unhinged" in dl.suggested_filename,
                  dl.suggested_filename)

            # --- EPUB download (unhinged) ---
            with page.expect_download(timeout=600000) as di2:
                page.click("#btn-epub")
            dl2 = di2.value
            epub_path = work / "out.epub"
            dl2.save_as(epub_path)
            with zipfile.ZipFile(epub_path) as z:
                infos = z.infolist()
                check("EPUB mimetype first + stored",
                      infos[0].filename == "mimetype"
                      and infos[0].compress_type == zipfile.ZIP_STORED
                      and z.read("mimetype") == b"application/epub+zip")
                chapters = [i.filename for i in infos
                            if i.filename.startswith("OEBPS/text/") and i.filename.endswith(".xhtml")]
                marked = 0
                marker_ok = 0
                parse_fail = []
                for c in chapters:
                    content = z.read(c).decode("utf-8")
                    if EMAIL in content:
                        marked += 1
                    if MARK_UNH in content:
                        marker_ok += 1
                    try:
                        ET.fromstring(content)
                    except ET.ParseError as exc:
                        parse_fail.append(f"{c}: {exc}")
                check("EPUB watermark in every chapter", marked == len(chapters) and chapters,
                      f"{marked}/{len(chapters)}")
                check("EPUB is the unhinged edition", marker_ok == len(chapters) and chapters,
                      f"{marker_ok}/{len(chapters)}")
                check("EPUB chapters still well-formed XML", not parse_fail,
                      "; ".join(parse_fail[:3]))

            # --- access-log payloads carry the right edition ---
            actions = {(p.get("action"), p.get("edition")) for p in log_posts}
            check("logged appropriate read-online",
                  ("read-online", "appropriate") in actions, str(sorted(actions)))
            check("logged unhinged read-online",
                  ("read-online", "unhinged") in actions, str(sorted(actions)))
            check("logged unhinged pdf + epub",
                  ("download-pdf", "unhinged") in actions and ("download-epub", "unhinged") in actions,
                  str(sorted(actions)))
            check("every log post has an edition field",
                  all(p.get("edition") in ("appropriate", "unhinged") for p in log_posts),
                  f"{len(log_posts)} posts")

            real_errors = [e for e in console_errors if "favicon" not in e.lower()]
            check("no console/page errors", not real_errors, "; ".join(real_errors[:3]))
            browser.close()
    finally:
        server.terminate()
        import shutil
        shutil.rmtree(work, ignore_errors=True)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
