#!/usr/bin/env python3
"""
test_e2e_dist.py - End-to-end test of the built reader_gate_dist folder.

Serves the REAL encrypted distribution (built by build_reader_gate.py) on
localhost and drives the full reader flow with Playwright:

  1. wrong access code is rejected, page stays locked
  2. correct code (lowercase + padding, exercising normalization) unlocks
  3. "Read in your browser" opens a page watermarked with the reader's email
  4. PDF download: every sampled page carries the email stamp (checked with fitz)
  5. EPUB download: mimetype first+stored, watermark in chapters, XML still valid

Usage (from the entropy folder, AFTER running build_reader_gate.py):
    py reader_gate/test_e2e_dist.py [dist_dir] [--code CODE] [--group LABEL]

Defaults: dist_dir = ./reader_gate_dist, code = CLUCK-AND-LEARN, group = students.
"""

import argparse
import socket
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

EMAIL = "early.reader@example.com"
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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dist", nargs="?", default=None)
    ap.add_argument("--code", default="CLUCK-AND-LEARN")
    ap.add_argument("--group", default="students")
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    dist = Path(args.dist).resolve() if args.dist else here.parent / "reader_gate_dist"
    if not dist.is_dir() or not (dist / "index.html").exists() or not (dist / "manifest.json").exists():
        print(f"Error: {dist} is not a built distribution (run build_reader_gate.py first).")
        return 1

    tmp = here / ".e2e_tmp"
    tmp.mkdir(exist_ok=True)
    port = free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", str(dist)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/"
    time.sleep(1.0)

    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(accept_downloads=True)
            page = ctx.new_page()
            console_errors = []
            page.on("pageerror", lambda e: console_errors.append(str(e)))
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

            page.goto(url, wait_until="networkidle")
            title = page.locator("#book-title").inner_text(timeout=10000)
            check("manifest loaded, title shown", "Chicken Whispering" in title, title)

            # --- 1. wrong code rejected ---
            page.fill("#code", "DEFINITELY-WRONG-CODE")
            page.fill("#email", EMAIL)
            page.check("#agree")
            page.click("#unlock-btn")
            page.wait_for_function(
                "() => { const s = document.querySelector('#form-status, #code-error');"
                " return document.body.innerText.toLowerCase().includes(\"didn't work\")"
                " || document.body.innerText.toLowerCase().includes('didn\\u2019t work'); }",
                timeout=120000)
            check("wrong code rejected", page.locator("#actions-section").is_hidden())

            # --- 2. correct code unlocks (lowercase + whitespace) ---
            page.fill("#code", "  " + args.code.lower() + "  ")
            page.click("#unlock-btn")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            check("correct code unlocks (normalized)", True)
            msg = page.locator("#unlock-message").inner_text()
            check("email shown, group label hidden from reader",
                  EMAIL in msg and args.group.lower() not in msg.lower(), msg)

            # --- 3. read online: watermark in opened page ---
            with ctx.expect_page(timeout=180000) as popup_info:
                page.click("#btn-read")
            book_page = popup_info.value
            book_page.wait_for_load_state("domcontentloaded", timeout=180000)
            book_page.wait_for_selector("#erc-watermark-banner", timeout=60000)
            banner = book_page.locator("#erc-watermark-banner").inner_text()
            check("HTML watermark banner has email", EMAIL in banner, banner.strip()[:80])
            body_text = book_page.locator("body").inner_text()
            check("book content present in HTML view", "Chicken Whispering" in body_text)
            book_page.close()

            # --- 4. PDF download stamped on every sampled page ---
            with page.expect_download(timeout=600000) as dl_info:
                page.click("#btn-pdf")
            dl = dl_info.value
            pdf_path = tmp / "test.pdf"
            dl.save_as(pdf_path)
            check("PDF downloaded", pdf_path.stat().st_size > 1_000_000,
                  f"{pdf_path.stat().st_size / 1024:.0f} KB, name: {dl.suggested_filename}")
            import fitz
            doc = fitz.open(str(pdf_path))
            n = doc.page_count
            sample = sorted({0, 1, n // 2, n - 2, n - 1} & set(range(n)))
            stamped = [i for i in sample if EMAIL in doc[i].get_text()]
            check(f"PDF watermark on sampled pages {sample} of {n}", stamped == sample,
                  f"stamped: {stamped}")
            doc.close()

            # --- 5. EPUB download: structure + watermark intact ---
            with page.expect_download(timeout=600000) as dl_info:
                page.click("#btn-epub")
            dl = dl_info.value
            epub_path = tmp / "test.epub"
            dl.save_as(epub_path)
            with zipfile.ZipFile(epub_path) as z:
                infos = z.infolist()
                check("EPUB mimetype first + stored",
                      infos[0].filename == "mimetype"
                      and infos[0].compress_type == zipfile.ZIP_STORED
                      and z.read("mimetype") == b"application/epub+zip")
                chapters = [i.filename for i in infos
                            if i.filename.startswith("OEBPS/text/") and i.filename.endswith(".xhtml")]
                check("EPUB has chapter files", len(chapters) >= 20, f"{len(chapters)} files")
                marked, parse_fail = 0, []
                for c in chapters:
                    content = z.read(c).decode("utf-8")
                    if EMAIL in content:
                        marked += 1
                    try:
                        ET.fromstring(content)
                    except ET.ParseError as exc:
                        parse_fail.append(f"{c}: {exc}")
                check("EPUB watermark in every chapter", marked == len(chapters),
                      f"{marked}/{len(chapters)}")
                check("EPUB chapters still well-formed XML", not parse_fail,
                      "; ".join(parse_fail[:3]))

            real_errors = [e for e in console_errors if "favicon" not in e.lower()]
            check("no console/page errors", not real_errors, "; ".join(real_errors[:3]))
            browser.close()
    finally:
        server.terminate()
        for f in tmp.glob("*"):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmp.rmdir()
        except OSError:
            pass

    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
