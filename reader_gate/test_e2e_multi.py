"""
test_e2e_multi.py - End-to-end test of the multi-edition reader gate with
per-code edition access (build_chickenwhispering_multi.py +
reader_gate/gate_template_multi.html + reader_gate/add_access_code.py).

Builds THREE throwaway editions (appropriate / unhinged / textbook) from tiny
artifacts with distinct content markers, using a codes file where:

    group1, group2  open all three editions
    partial1        opens appropriate + textbook
    students1       opens textbook only

Builder checks (no browser):
  - builds from book JSON and re-assembles from the prebuilt bundles
  - codes never appear in builder output
  - refuses: a changed code, a code list that no longer matches a bundle,
    an unknown Opens key, an edition no code opens
  - the page gets exactly the editions in the build
  - add_access_code.py migrates a two-column file and adds a code without
    printing it or altering existing rows

Browser checks (headless Chromium):
  - wrong code rejected; the unlock status never names an edition
  - all-access code: three editions, NONE pre-selected, buttons disabled
    until a choice; each edition reads/downloads its own content
  - switching is locked while a download runs; the file, watermark and log
    all belong to the edition that was downloaded
  - student code: picker hidden, textbook auto-selected and named, no other
    edition name anywhere on the page
  - partial code: only its two editions are shown
  - access log: unlock lists the opened editions; actions carry the edition
  - an edition folder missing from the site, and a page without its edition
    list, fail with clear messages
  - no console / page errors

No real book content or real codes are used.

Usage (from the entropy folder):
    py reader_gate/test_e2e_multi.py
"""

import contextlib
import io
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENTROPY = HERE.parent
sys.path.insert(0, str(ENTROPY))
sys.path.insert(0, str(HERE))

import build_reader_gate as brg                      # noqa: E402
import build_chickenwhispering_multi as multi        # noqa: E402
import add_access_code                               # noqa: E402

EMAIL = "early.reader@example.com"
CODE = "TEST-CODE-ALPHA"
CODE2 = "TEST-CODE-BETA"
CODE_PARTIAL = "TEST-CODE-GAMMA"
CODE_STUDENT = "TEST-CODE-DELTA"
ALL_CODES = (CODE, CODE2, CODE_PARTIAL, CODE_STUDENT)
LOG_URL = "https://example.test/log-sink"

# Distinct, unmistakable per-edition content markers.
MARK = {
    "appropriate": "SORTA-APPROPRIATE-CONTENT-MARKER",
    "unhinged": "UNHINGED-CONTENT-MARKER",
    "textbook": "TEXTBOOK-CONTENT-MARKER",
}
LABELS = {e["key"]: e["label"] for e in multi.EDITION_CATALOG}

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


def make_book(src_dir, marker):
    """Book JSON + html/pdf/epub siblings, so --reuse skips the real exporters."""
    src_dir.mkdir(parents=True, exist_ok=True)
    book = src_dir / "book.json"
    book.write_text(json.dumps({"meta": {
        "title": "Chicken Whispering",
        "subtitle": "A smart, dumb, and maybe insane guide.",
        "author": "Scott DuHadway",
        "modified": "2026-11-10T00:00:00Z",
    }, "nodes": []}), encoding="utf-8")
    (src_dir / "book.html").write_bytes(make_html(marker))
    (src_dir / "book.pdf").write_bytes(make_pdf(marker))
    (src_dir / "book.epub").write_bytes(make_epub(marker))
    return book


def write_codes(path, rows):
    """rows = [(label, code, opens)] written in the real box-table format."""
    path.write_text("\n".join(add_access_code.render_table(rows)) + "\n", encoding="utf-8")
    return path


def run_builder(args):
    """multi.main(args) -> (exit code, captured stdout)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = multi.main([str(a) for a in args])
    return rc, buf.getvalue()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def serve(directory):
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", str(directory)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    return proc, f"http://127.0.0.1:{port}/"


# ---------------------------------------------------------------------------
# Builder + codes-file checks (no browser)
# ---------------------------------------------------------------------------
def builder_checks(work):
    print("\nBuilder checks")
    books = {k: make_book(work / "src" / k, MARK[k]) for k in MARK}
    rows = [("group1", CODE.lower(), "all"), ("group2", CODE2, "all"),
            ("partial1", CODE_PARTIAL, "appropriate, textbook"),
            ("students1", CODE_STUDENT, "textbook")]
    codes = write_codes(work / "codes.txt", rows)

    out = work / "site"
    args = ["--codes-file", codes, "--log-endpoint", LOG_URL, "--reuse", "--out", out]
    for k in ("appropriate", "unhinged", "textbook"):
        args += ["--edition-json", f"{k}={books[k]}"]
    rc, log = run_builder(args)
    check("builds three editions from book JSON", rc == 0, log.strip().splitlines()[-1] if log else "")
    check("builder output never contains a code",
          not any(c.upper() in log.upper() for c in ALL_CODES))
    for k in MARK:
        m = json.loads((out / k / "manifest.json").read_text(encoding="utf-8"))
        want = {"appropriate": {"group1", "group2", "partial1"},
                "unhinged": {"group1", "group2"},
                "textbook": {"group1", "group2", "partial1", "students1"}}[k]
        got = {c["label"] for c in m["codes"]}
        check(f"{k} manifest lists exactly its codes", got == want, str(sorted(got)))
    idx = (out / "index.html").read_text(encoding="utf-8")
    check("page has its edition list injected", multi.CONFIG_TOKEN not in idx
          and '"key": "appropriate"' in idx and '"key": "textbook"' in idx)

    # Re-assemble from the prebuilt bundles (the path used for live bundles).
    re_out = work / "site_reassembled"
    rc, log = run_builder(["--codes-file", codes, "--out", re_out]
                          + [x for k in MARK for x in ("--edition", f"{k}={out / k}")])
    check("re-assembles from prebuilt bundles after verifying codes", rc == 0,
          log.strip().splitlines()[-1] if log else "")
    same = all((re_out / k / bn).read_bytes() == (out / k / bn).read_bytes()
               for k in MARK for bn in multi.BIN_NAMES)
    check("prebuilt blobs copied byte-for-byte", same)

    # Two-edition build: page lists only those; the student row is noted.
    two = work / "site_two"
    rc, log = run_builder(["--codes-file", codes, "--out", two,
                           "--edition", f"appropriate={out / 'appropriate'}",
                           "--edition", f"unhinged={out / 'unhinged'}"])
    idx2 = (two / "index.html").read_text(encoding="utf-8") if rc == 0 else ""
    check("two-edition build lists only those editions",
          rc == 0 and '"key": "unhinged"' in idx2 and '"key": "textbook"' not in idx2)
    check("access table notes codes for editions not in the build",
          "students1" in log and "not in this build" in log)

    # Refusals.
    bad_code = write_codes(work / "codes_bad.txt",
                           [("group1", "TEST-CODE-WRONG", "all")] + rows[1:])
    rc, log = run_builder(["--codes-file", bad_code, "--out", work / "x1",
                           "--edition", f"unhinged={out / 'unhinged'}"])
    check("refuses a bundle the codes file's code cannot open",
          rc == 1 and "does not open" in log and "TEST-CODE-WRONG" not in log.upper(),
          log.strip().splitlines()[-1] if log else "")
    widened = write_codes(work / "codes_widened.txt",
                          rows[:2] + [("partial1", CODE_PARTIAL, "all")] + rows[3:])
    rc, log = run_builder(["--codes-file", widened, "--out", work / "x2",
                           "--edition", f"unhinged={out / 'unhinged'}"])
    check("refuses a bundle whose code list no longer matches", rc == 1 and "do not match" in log)
    unknown = write_codes(work / "codes_unknown.txt", rows[:3] + [("students1", CODE_STUDENT, "txtbook")])
    rc, log = run_builder(["--codes-file", unknown, "--out", work / "x3",
                           "--edition", f"textbook={out / 'textbook'}"])
    check("refuses an unknown edition key in Opens", rc == 1 and "unknown edition" in log)
    only_students = write_codes(work / "codes_students.txt", [rows[3]])
    rc, log = run_builder(["--codes-file", only_students, "--out", work / "x4",
                           "--edition", f"unhinged={out / 'unhinged'}"])
    check("refuses an edition that no code opens", rc == 1 and "no code" in log)
    check("refusals wrote nothing", not any((work / x).exists() for x in ("x1", "x2", "x3", "x4")))

    # add_access_code.py: migrate a legacy two-column table and add a code.
    legacy = work / "codes_legacy.txt"
    legacy.write_text(
        "  │ Label  │ Code            │\n  ├────────┼─────────────────┤\n"
        f"  │ group1 │ {CODE}  │\n  ├────────┼─────────────────┤\n"
        f"  │ group2 │ {CODE2}   │\n", encoding="utf-8")
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = add_access_code.main(["--codes-file", str(legacy), "--label", "students1",
                                   "--opens", "textbook", "--existing-opens", "all"])
    printed = buf.getvalue()
    parsed = multi.read_codes_file(legacy) if rc == 0 else []
    new = [r for r in parsed if r["label"] == "students1"]
    check("add_access_code adds a row and keeps existing rows",
          rc == 0 and [(r["label"], r["code"], r["opens"]) for r in parsed[:2]]
          == [("group1", CODE, None), ("group2", CODE2, None)]
          and len(new) == 1 and new[0]["opens"] == frozenset({"textbook"}))
    check("generated code: 12 chars from the unambiguous alphabet",
          bool(new) and len(new[0]["code"]) == 12
          and all(ch in add_access_code.ALPHABET for ch in new[0]["code"]))
    check("add_access_code never prints the code", bool(new) and new[0]["code"] not in printed)
    check("add_access_code wrote a backup", any(p.name.startswith("codes_legacy.txt.bak-")
                                                for p in work.iterdir()))
    return out


# ---------------------------------------------------------------------------
# Browser checks
# ---------------------------------------------------------------------------
STATUS_SPY = """() => {
  window.__statusLog = [];
  const el = document.getElementById('form-status');
  new MutationObserver(() => window.__statusLog.push(el.textContent))
    .observe(el, {childList: true, characterData: true, subtree: true});
}"""


def unlock(page, code, email=EMAIL):
    page.evaluate(STATUS_SPY)
    page.fill("#code", code)
    page.fill("#email", email)
    page.check("#agree")
    page.click("#unlock-btn")


def status_named_edition(page):
    texts = page.evaluate("window.__statusLog || []")
    return [t for t in texts if any(lbl in t for lbl in LABELS.values())]


def read_online(ctx, page):
    with ctx.expect_page(timeout=180000) as pi:
        page.click("#btn-read")
    bp = pi.value
    bp.wait_for_load_state("domcontentloaded", timeout=180000)
    bp.wait_for_selector("#erc-watermark-banner", timeout=60000)
    body = bp.locator("body").inner_text()
    banner = bp.locator("#erc-watermark-banner").inner_text()
    bp.close()
    return body, banner


def pdf_text(path):
    import fitz
    doc = fitz.open(str(path))
    texts = [doc[i].get_text() for i in range(doc.page_count)]
    doc.close()
    return texts


def browser_checks(site, work):
    from playwright.sync_api import sync_playwright
    print("\nBrowser checks")
    server, url = serve(site)
    missing = work / "site_missing"
    shutil.copytree(site, missing)
    shutil.rmtree(missing / "textbook")
    server_missing, url_missing = serve(missing)
    raw = work / "site_raw"
    raw.mkdir()
    shutil.copy2(multi.GATE_MULTI_TEMPLATE, raw / "index.html")
    shutil.copytree(site / "vendor", raw / "vendor")
    server_raw, url_raw = serve(raw)

    log_posts = []

    def handle_log(route):
        try:
            body = route.request.post_data
            if body:
                log_posts.append(json.loads(body))
        except Exception:
            pass
        route.fulfill(status=200, content_type="application/json", body="{}")

    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()

            def new_page():
                ctx = browser.new_context(accept_downloads=True)
                ctx.route("**/log-sink", handle_log)
                page = ctx.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                return ctx, page, errors

            # ---------------- all-access reader ----------------
            ctx, page, errors = new_page()
            page.goto(url, wait_until="networkidle")
            title = page.locator("#book-title").inner_text(timeout=10000)
            check("manifests loaded, title shown", "Chicken Whispering" in title, title)

            unlock(page, "DEFINITELY-WRONG-CODE")
            page.wait_for_function(
                "() => document.body.innerText.toLowerCase().includes(\"didn't work\")"
                " || document.body.innerText.toLowerCase().includes('didn\\u2019t work')",
                timeout=120000)
            check("wrong code rejected", page.locator("#actions-section").is_hidden())
            check("unlock status never names an edition (wrong code)",
                  not status_named_edition(page), str(status_named_edition(page)))

            unlock(page, "  " + CODE.lower() + "  ")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            check("all-access code unlocks (normalized)", True)
            check("unlock status never names an edition (valid code)",
                  not status_named_edition(page), str(status_named_edition(page)))
            check("edition picker visible", page.locator("#edition-toggle").is_visible())
            radios = page.locator("input[name='edition']")
            check("all three editions offered", radios.count() == 3, str(radios.count()))
            check("no edition pre-selected",
                  page.locator("input[name='edition']:checked").count() == 0)
            check("buttons disabled until a choice",
                  all(page.locator(b).is_disabled() for b in ("#btn-read", "#btn-pdf", "#btn-epub")))
            check("prompt asks for a choice",
                  "Choose an edition" in page.locator("#edition-prompt").inner_text())
            check("no 'does not unlock' text anywhere",
                  "does not unlock" not in page.locator("body").inner_text())

            page.check("#edition-appropriate")
            check("choosing enables the buttons",
                  all(page.locator(b).is_enabled() for b in ("#btn-read", "#btn-pdf", "#btn-epub")))
            check("prompt names the chosen edition",
                  LABELS["appropriate"] in page.locator("#edition-prompt").inner_text())
            body, banner = read_online(ctx, page)
            check("appropriate content when appropriate chosen",
                  MARK["appropriate"] in body and MARK["unhinged"] not in body)
            check("HTML watermark has email", EMAIL in banner)

            page.check("#edition-unhinged")
            body, _ = read_online(ctx, page)
            check("unhinged content after switching",
                  MARK["unhinged"] in body and MARK["appropriate"] not in body)

            with page.expect_download(timeout=600000) as di:
                page.click("#btn-pdf")
            dl = di.value
            p = work / "unhinged.pdf"
            dl.save_as(p)
            texts = pdf_text(p)
            check("PDF watermarked on every page", bool(texts) and all(EMAIL in t for t in texts))
            check("PDF is the unhinged edition and named so",
                  MARK["unhinged"] in "".join(texts) and "Unhinged" in dl.suggested_filename,
                  dl.suggested_filename)

            with page.expect_download(timeout=600000) as di2:
                page.click("#btn-epub")
            e = work / "unhinged.epub"
            di2.value.save_as(e)
            with zipfile.ZipFile(e) as z:
                infos = z.infolist()
                chapters = [i.filename for i in infos
                            if i.filename.startswith("OEBPS/text/") and i.filename.endswith(".xhtml")]
                contents = [z.read(c).decode("utf-8") for c in chapters]
                bad_xml = []
                for c, s in zip(chapters, contents):
                    try:
                        ET.fromstring(s)
                    except ET.ParseError as exc:
                        bad_xml.append(f"{c}: {exc}")
                check("EPUB mimetype first + stored",
                      infos[0].filename == "mimetype" and infos[0].compress_type == zipfile.ZIP_STORED)
                check("EPUB watermark + unhinged content in every chapter",
                      bool(chapters) and all(EMAIL in s and MARK["unhinged"] in s for s in contents))
                check("EPUB chapters still well-formed XML", not bad_xml, "; ".join(bad_xml[:2]))

            # Mid-download switch: hold the textbook PDF request and try to switch.
            held = []
            page.route("**/textbook/pdf.bin*", lambda r: held.append(r))
            page.check("#edition-textbook")
            with page.expect_download(timeout=60000) as di3:
                page.click("#btn-pdf")
                for _ in range(100):
                    if held:
                        break
                    page.wait_for_timeout(100)
                locked = page.locator("#edition-appropriate").is_disabled()
                check("edition choice locked while a download runs", locked)
                if not locked:   # the old behaviour: switching was possible
                    page.check("#edition-appropriate")
                held[0].continue_()
            dl3 = di3.value
            p3 = work / "textbook.pdf"
            dl3.save_as(p3)
            joined = "".join(pdf_text(p3))
            check("downloaded file matches its name (textbook)",
                  MARK["textbook"] in joined and LABELS["textbook"] in dl3.suggested_filename,
                  dl3.suggested_filename)
            page.wait_for_function("() => !document.getElementById('edition-appropriate').disabled",
                                   timeout=10000)
            check("edition choice unlocked after the download", True)

            check("no console/page errors (all-access reader)",
                  not [x for x in errors if "favicon" not in x.lower()],
                  "; ".join(errors[:3]))
            ctx.close()

            # ---------------- student (textbook only) ----------------
            ctx, page, errors = new_page()
            page.goto(url, wait_until="networkidle")
            unlock(page, CODE_STUDENT, "student@example.com")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            visible = page.locator("body").inner_text()
            check("student: picker hidden", page.locator("#edition-toggle").is_hidden())
            check("student: only one edition in the page",
                  page.locator("input[name='edition']").count() == 1)
            check("student: no other edition named on screen",
                  LABELS["appropriate"] not in visible and LABELS["unhinged"] not in visible)
            check("student: unlock status never names an edition",
                  not status_named_edition(page), str(status_named_edition(page)))
            check("student: welcome names the textbook edition",
                  LABELS["textbook"] in page.locator("#unlock-message").inner_text())
            check("student: buttons ready without a click",
                  page.locator("#btn-read").is_enabled())
            body, _ = read_online(ctx, page)
            check("student: reads the textbook edition",
                  MARK["textbook"] in body and MARK["unhinged"] not in body
                  and MARK["appropriate"] not in body)
            check("no console/page errors (student)",
                  not [x for x in errors if "favicon" not in x.lower()], "; ".join(errors[:3]))
            ctx.close()

            # ---------------- partial code (appropriate + textbook) ----------------
            ctx, page, errors = new_page()
            page.goto(url, wait_until="networkidle")
            unlock(page, CODE_PARTIAL, "partial@example.com")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            values = page.eval_on_selector_all("input[name='edition']", "els => els.map(e => e.value)")
            check("partial: exactly its two editions offered",
                  values == ["appropriate", "textbook"], str(values))
            check("partial: unhinged not named on screen",
                  LABELS["unhinged"] not in page.locator("body").inner_text())
            check("partial: nothing pre-selected",
                  page.locator("input[name='edition']:checked").count() == 0)
            ctx.close()

            # ---------------- edition folder missing from the site ----------------
            ctx, page, _ = new_page()
            page.goto(url_missing, wait_until="networkidle")
            unlock(page, CODE_STUDENT, "student@example.com")
            page.wait_for_function(
                "() => document.getElementById('form-status').textContent.includes('loaded')",
                timeout=120000)
            check("missing edition: student told it could not be loaded",
                  "couldn't be loaded" in page.locator("#form-status").inner_text())
            unlock(page, CODE, "missing@example.com")
            page.wait_for_selector("#actions-section", state="visible", timeout=120000)
            check("missing edition: others still open, with a neutral note",
                  page.locator("input[name='edition']").count() == 2
                  and page.locator("#edition-note").is_visible())
            ctx.close()

            # ---------------- template without its edition list ----------------
            ctx, page, _ = new_page()
            page.goto(url_raw, wait_until="networkidle")
            check("un-built template shows a clear error",
                  page.locator("#manifest-error").is_visible()
                  and "edition list" in page.locator("#manifest-error-text").inner_text())
            ctx.close()
            browser.close()
    finally:
        for s in (server, server_missing, server_raw):
            s.terminate()

    # ---------------- access log ----------------
    unlocks = [p for p in log_posts if p.get("action") == "unlock"]
    by_email = {p["email"]: p for p in unlocks}
    check("unlock logged with every opened edition (all-access)",
          by_email.get(EMAIL, {}).get("edition") == "appropriate,unhinged,textbook"
          and by_email.get(EMAIL, {}).get("group") == "group1",
          str(by_email.get(EMAIL)))
    check("unlock logged for the student with textbook only",
          by_email.get("student@example.com", {}).get("edition") == "textbook"
          and by_email.get("student@example.com", {}).get("group") == "students1",
          str(by_email.get("student@example.com")))
    acts = {(p.get("email"), p.get("action"), p.get("edition")) for p in log_posts}
    check("actions logged under the edition actually delivered",
          {(EMAIL, "read-online", "appropriate"), (EMAIL, "read-online", "unhinged"),
           (EMAIL, "download-pdf", "unhinged"), (EMAIL, "download-epub", "unhinged"),
           (EMAIL, "download-pdf", "textbook"),
           ("student@example.com", "read-online", "textbook")} <= acts,
          str(sorted(acts)))
    check("no action logged for an edition that was not delivered",
          (EMAIL, "download-pdf", "appropriate") not in acts)


def main():
    work = Path(tempfile.mkdtemp(prefix="cw_multi_test_"))
    try:
        site = builder_checks(work)
        browser_checks(site, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
