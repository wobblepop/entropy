"""End-to-end check of the editor's "Generate PDF" picker against the real local PDF
service, in headless Chromium (Playwright).

What it proves:
  1. editor.html loads with no page errors; the PDF header button opens a picker that
     lists every section once, in reading order, with the node being edited and its
     sub-sections pre-ticked; the palette offers "Generate PDF…"; the picker reports the
     PDF service as ready.
  2. Ticking a chapter ticks its sub-sections; a sub-section or the heading can be
     unticked on its own; the summary counts what will print.
  3. Generate PDF downloads a real PDF named "<book> - <first> to <last>.pdf": text pages
     with embedded fonts, a cover, a contents page listing exactly the ticked sections
     with page numbers that match where each section starts, one section per page, and
     no unticked section anywhere.
  4. A single ticked section (saved with Enter) gives cover + contents + that section,
     named "<book> - <section>.pdf".
  5. The service answers /health, rejects bad requests with a JSON error (unknown section
     id, junk body, not a book, unknown endpoint), and never rasterizes.
  6. With the service unreachable the picker says how to start it and Generate is disabled.

Run from the repo root (build first so editor.html embeds the current picker):
    py build_editor.py
    py editor/test/e2e_pdf_export.py
Requires: playwright (py -m pip install playwright; py -m playwright install chromium),
pymupdf, pypdf. Uses port 8645 for the service (8646 must be closed).
Exit code 0 on success, 1 on any failure.
"""
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")   # summaries contain "…"
except (AttributeError, ValueError):
    pass

ROOT = Path(__file__).resolve().parents[2]
EDITOR_HTML = ROOT / "editor.html"
BOOK_PATH = ROOT / "sample" / "demo-textbook.entropy.json"
SERVICE_PORT = 8645
SERVICE_URL = f"http://127.0.0.1:{SERVICE_PORT}"
DEAD_URL = "http://127.0.0.1:8646"
MARK = "ENTRPGMK"

failures = []


def check(cond, msg):
    if cond:
        print("  ok  ", msg)
    else:
        print("  FAIL", msg)
        failures.append(msg)


# --- independent Python mirrors of the section walks (expected values) ---

def subtree(data, root):
    out, seen = [], set()

    def walk(i):
        if i in seen or i not in data["nodes"]:
            return
        seen.add(i)
        out.append(i)
        for c in data["nodes"][i].get("children") or []:
            walk(c)

    walk(root)
    return out


def linear(data):
    out = subtree(data, data["root"])
    seen = set(out)
    for i in data["nodes"]:
        if i not in seen:
            out.append(i)
    return out


def expand(data, ids, kids):
    wanted = set()
    for i in ids:
        if i in data["nodes"]:
            wanted.update(subtree(data, i) if kids else [i])
    return [i for i in linear(data) if i in wanted]


def depths(data):
    d = {}

    def walk(i, n):
        if i in d or i not in data["nodes"]:
            return
        d[i] = n
        for c in data["nodes"][i].get("children") or []:
            walk(c, n + 1)

    walk(data["root"], 0)
    return d


def labels(data):
    out, s = {}, (data.get("meta") or {}).get("structure")
    if not isinstance(s, dict):
        return out
    ch = 0
    for p in s.get("parts") or []:
        for nid in (p or {}).get("nodes") or []:
            ch += 1
            if isinstance(nid, str):
                out[nid] = f"Chapter {ch}"
    for e in s.get("epilogues") or []:
        if isinstance(e, dict) and isinstance(e.get("node"), str):
            out[e["node"]] = "Epilogue"
    return out


def pdf_file_title(book, label, title):
    bits = [b.strip() for b in (book, label, title) if b and b.strip()]
    joined = " - ".join(bits) or "section"
    return re.sub(r"\s+", " ", re.sub(r'[\\/:*?"<>|]+', "-", joined)).strip()[:120]


def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def toc_link_pages(path):
    """Map a contents entry's title -> the 0-based page its link lands on.

    The contents entries are real GOTO links in the merged PDF, so a section can
    be located without anything being hidden in the page text: the exporter now
    keeps its ENTRPGMK markers to the throwaway first pass."""
    import fitz
    doc = fitz.open(str(path))
    try:
        if doc.page_count < 2:
            return {}
        toc = doc[1]
        found = {}
        for link in toc.get_links():
            target = link.get("page", -1)
            rect = link.get("from")
            if target < 0 or rect is None:
                continue
            label = norm(toc.get_textbox(rect))
            if label:
                found.setdefault(label, target)
        return found
    finally:
        doc.close()


# --- service plumbing ---

def http(method, path, body=None, raw=None, timeout=300):
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    req = urllib.request.Request(SERVICE_URL + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def start_service():
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "pdf_service.py"), "--port", str(SERVICE_PORT), "--base-dir", str(ROOT / "sample")],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    deadline = time.time() + 60
    while time.time() < deadline:
        if proc.poll() is not None:
            print("service exited early:\n" + (proc.stdout.read() if proc.stdout else ""))
            return None
        try:
            status, body, _ = http("GET", "/health", timeout=2)
            if status == 200 and json.loads(body).get("ok") is True:
                return proc
        except Exception:
            pass
        time.sleep(0.5)
    print("service did not become healthy within 60 s")
    proc.kill()
    return None


def stop_service(proc):
    if proc is None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def port_is_closed(port):
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) != 0


def main():
    if not EDITOR_HTML.exists():
        print("editor.html missing — run: py build_editor.py")
        return 1
    if not BOOK_PATH.exists():
        print(f"sample book missing: {BOOK_PATH}")
        return 1
    sync = subprocess.run([sys.executable, str(ROOT / "build_editor.py"), "--check"], capture_output=True, text=True)
    if sync.returncode != 0:
        print(sync.stdout.strip())
        print("editor.html is stale — run: py build_editor.py")
        return 1
    if not port_is_closed(8646):
        print("port 8646 must be closed (it stands in for a stopped service)")
        return 1
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("playwright is not installed: py -m pip install playwright && py -m playwright install chromium")
        return 1
    try:
        from pypdf import PdfReader
    except ImportError:
        print("pypdf is not installed: py -m pip install pypdf")
        return 1

    data = json.loads(BOOK_PATH.read_text(encoding="utf-8"))
    book_title = (data.get("meta") or {}).get("title") or ""
    order = linear(data)
    lab = labels(data)
    dep = depths(data)
    titles = {i: n.get("title") or i for i, n in data["nodes"].items()}
    chapters = [i for i in order if dep.get(i) == 1]
    if len(chapters) < 3:
        print("sample book needs at least three top-level chapters for this check")
        return 1
    pick_a = [chapters[0], chapters[-1]]
    exp_a = expand(data, pick_a, True)
    name = lambda i: lab.get(i) or titles[i]
    title_a = pdf_file_title(book_title, "", f"{name(pick_a[0])} to {name(pick_a[-1])}")
    pick_b = chapters[1]
    title_b = pdf_file_title(book_title, lab.get(pick_b, ""), titles[pick_b])

    def verify_pdf(path, expected_ids, label):
        reader = PdfReader(str(path))
        raw_pages = [(pg.extract_text() or "") for pg in reader.pages]
        pages = [norm(t) for t in raw_pages]
        squashed = [re.sub(r"\s+", "", t) for t in raw_pages]
        check(len(pages) >= 2 + len(expected_ids), f"{label}: {len(pages)} pages = cover + contents + at least one per section")
        check(book_title and book_title in pages[0], f"{label}: cover carries the book title")
        check(len(pages) > 1 and "Table of contents" in pages[1], f"{label}: page 2 is the contents page")
        fonts_ok = all(bool((pg.get("/Resources") or {}).get("/Font")) for pg in reader.pages[1:])
        check(fonts_ok, f"{label}: every body page has embedded fonts (text, not pictures)")
        check(all(MARK not in t for t in squashed),
              f"{label}: no page-marker text leaks into the delivered PDF")
        links = toc_link_pages(path)
        starts = []
        for i in expected_ids:
            m = re.search(re.escape(norm(titles[i])) + r"\s*(\d+)", pages[1]) if len(pages) > 1 else None
            check(m is not None, f"{label}: contents lists '{titles[i]}' with a page number")
            toc_num = int(m.group(1)) if m else None
            idx = links.get(norm(titles[i]))
            check(idx is not None, f"{label}: '{titles[i]}' is linked from the contents")
            check(idx is not None and toc_num == idx, f"{label}: contents says page {toc_num}, its link lands on page {idx} (cover unnumbered)")
            check(idx is not None and norm(titles[i]) in pages[idx], f"{label}: '{titles[i]}' heading is on its page as text")
            starts.append(idx)
        check(None not in starts and starts == sorted(starts) and len(set(starts)) == len(starts),
              f"{label}: sections start on distinct pages in reading order")
        for i in order:
            if i not in expected_ids:
                # A title could in principle also surface as a "See also" label
                # pointing at an unrendered node, so read a failure here before
                # assuming the selection logic broke.
                check(norm(titles[i]) not in links, f"{label}: unticked '{titles[i]}' is not in the contents")
                check(all(norm(titles[i]) not in t for t in pages), f"{label}: unticked '{titles[i]}' is absent")
        return pages

    proc = start_service()
    if proc is None:
        return 1
    tmp = Path(tempfile.mkdtemp(prefix="entropy-e2e-"))
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(accept_downloads=True)
            ctx.add_init_script(
                "try { localStorage.setItem('entropy-pdf-service-url', '%s'); } catch (e) {}\n"
                "Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });" % SERVICE_URL)
            page = ctx.new_page()
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            page.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)

            print("1. editor loads, picker lists every section, service is ready")
            page.goto(EDITOR_HTML.as_uri())
            page.wait_for_load_state("load")
            page.evaluate("d => EditorState.loadContent(d, 'demo.json')", data)
            selected = page.evaluate("EditorState.getSelectedNodeId()")
            page.keyboard.press("Control+k")
            page.wait_for_selector("#command-palette:not([hidden])")
            cmds = page.eval_on_selector_all("#palette-results .result-label", "els => els.map(e => e.textContent)")
            check("Generate PDF…" in cmds, "palette offers 'Generate PDF…'")
            check(not any("via Viewer" in c or "Save as PDF" in c for c in cmds), "palette has no print-based PDF command")
            page.keyboard.press("Escape")
            page.click("#btn-pdf")
            page.wait_for_selector("#pdf-modal:not([hidden])")
            ids = page.eval_on_selector_all("#pdf-tree input[name=pdf-node]", "els => els.map(e => e.value)")
            check(ids == order, f"picker lists all {len(order)} sections in reading order")
            ticked = lambda: page.eval_on_selector_all("#pdf-tree input:checked", "els => els.map(e => e.value)")
            check(ticked() == subtree(data, selected), f"node being edited ({selected}) and its sub-sections are pre-ticked")
            classes = page.eval_on_selector_all("#pdf-tree .pdf-item", "els => els.map(e => e.className)")
            check(all(f"depth-{min(dep.get(i, 0), 5)}" in c for i, c in zip(ids, classes)), "rows carry their tree depth")
            page.wait_for_selector("#pdf-service-status.ok", timeout=15000)
            check(SERVICE_URL in page.text_content("#pdf-service-text"), "picker reports the PDF service as ready")
            check(not page.is_disabled("#pdf-save-btn"), "Generate is enabled with ticks and a ready service")

            print("2. cascading ticks")
            page.click("#pdf-select-none")
            check(page.text_content("#pdf-summary") == "No sections ticked", "None empties the pick")
            check(page.is_disabled("#pdf-save-btn"), "Generate is disabled with nothing ticked")
            page.check(f'#pdf-tree input[value="{pick_a[0]}"]')
            check(ticked() == subtree(data, pick_a[0]), f"ticking {pick_a[0]} cascades to its sub-sections")
            page.check(f'#pdf-tree input[value="{pick_a[1]}"]')
            check(ticked() == exp_a, "second chapter cascades too; ticks stay in reading order")
            check(page.text_content("#pdf-summary") == f"{len(exp_a)} sections will print in reading order", "summary counts what will print")
            kid = (data["nodes"][pick_a[0]].get("children") or [None])[0]
            if kid:
                page.uncheck(f'#pdf-tree input[value="{kid}"]')
                check(ticked() == [i for i in exp_a if i != kid], f"unticking sub-section {kid} drops only it")
                page.uncheck(f'#pdf-tree input[value="{pick_a[0]}"]')
                check(ticked() == [i for i in exp_a if i not in (kid, pick_a[0])], "unticking the heading keeps its remaining sub-sections")
                page.check(f'#pdf-tree input[value="{pick_a[0]}"]')
                check(ticked() == exp_a, "re-ticking the heading re-ticks its sub-sections")

            print("3. Generate PDF: a real PDF from the service")
            with page.expect_download(timeout=300000) as dl_info:
                page.click("#pdf-save-btn")
            download = dl_info.value
            check(download.suggested_filename == title_a + ".pdf", f"download is named '{title_a}.pdf'")
            multi_pdf = tmp / "multi.pdf"
            download.save_as(str(multi_pdf))
            check(multi_pdf.read_bytes()[:4] == b"%PDF", "download is a PDF")
            check(page.is_hidden("#pdf-modal"), "picker closes once the PDF is handed over")
            check(page.title() == "EntropyEditor", "editor title untouched")
            verify_pdf(multi_pdf, exp_a, "multi")
            print(f"     pdf: {multi_pdf}")

            print("4. single section, saved with Enter")
            page.click("#btn-pdf")
            page.wait_for_selector("#pdf-modal:not([hidden])")
            page.wait_for_selector("#pdf-service-status.ok", timeout=15000)
            page.click("#pdf-select-current")
            check(ticked() == subtree(data, selected), "'Current section' re-ticks the node being edited with its sub-sections")
            page.click("#pdf-select-none")
            page.check(f'#pdf-tree input[value="{pick_b}"]')
            for kid in subtree(data, pick_b)[1:]:
                page.uncheck(f'#pdf-tree input[value="{kid}"]')
            check(ticked() == [pick_b], f"only {pick_b} remains ticked after dropping its sub-sections")
            check(page.text_content("#pdf-summary") == "1 section will print", "summary reads '1 section will print'")
            page.focus(f'#pdf-tree input[value="{pick_b}"]')
            with page.expect_download(timeout=300000) as dl_info:
                page.keyboard.press("Enter")
            download = dl_info.value
            check(download.suggested_filename == title_b + ".pdf", f"download is named '{title_b}.pdf'")
            single_pdf = tmp / "single.pdf"
            download.save_as(str(single_pdf))
            verify_pdf(single_pdf, [pick_b], "single")

            print("5. service API")
            status, body, _ = http("GET", "/health", timeout=5)
            info = json.loads(body)
            check(status == 200 and info.get("ok") is True and info.get("service") == "entropy-pdf", "/health answers ok")
            status, body, _ = http("POST", "/pdf", {"data": data, "sections": ["nope"]}, timeout=30)
            check(status == 400 and "unknown section" in json.loads(body).get("error", ""), "unknown section id -> 400 with a JSON error")
            status, body, _ = http("POST", "/pdf", raw=b"{not json", timeout=30)
            check(status == 400 and "JSON" in json.loads(body).get("error", ""), "junk body -> 400")
            status, body, _ = http("POST", "/pdf", {"data": {"x": 1}}, timeout=30)
            check(status == 400 and "Entropy book" in json.loads(body).get("error", ""), "not a book -> 400")
            status, body, _ = http("POST", "/pdf", {"data": data, "sections": []}, timeout=30)
            check(status == 400 and "no sections" in json.loads(body).get("error", ""), "empty selection -> 400")
            status, body, _ = http("GET", "/nothing", timeout=5)
            check(status == 404, "unknown endpoint -> 404")
            status, body, headers = http("POST", "/pdf", {"data": data, "sections": [pick_b], "filename": 'we/ird: name?.pdf'}, timeout=300)
            cd = headers.get("Content-Disposition", "")
            check(status == 200 and body[:4] == b"%PDF" and headers.get("Content-Type", "").startswith("application/pdf"), "direct POST returns a PDF")
            check('filename="we-ird- name-.pdf"' in cd, f"file name is sanitised in Content-Disposition ({cd})")

            errors_before_down = list(errors)

            print("6. service not running")
            page.evaluate("localStorage.setItem('entropy-pdf-service-url', '%s')" % DEAD_URL)
            page.click("#btn-pdf")
            page.wait_for_selector("#pdf-modal:not([hidden])")
            page.wait_for_selector("#pdf-service-status.down", timeout=15000)
            check("py pdf_service.py" in page.text_content("#pdf-service-text"), "picker explains how to start the service")
            check(page.is_visible("#pdf-service-retry"), "Retry button shown")
            check(page.is_disabled("#pdf-save-btn"), "Generate is disabled while the service is down")
            page.evaluate("localStorage.setItem('entropy-pdf-service-url', '%s')" % SERVICE_URL)
            page.click("#pdf-service-retry")
            page.wait_for_selector("#pdf-service-status.ok", timeout=15000)
            check(not page.is_disabled("#pdf-save-btn"), "Retry finds the service again and re-enables Generate")
            browser.close()
    finally:
        stop_service(proc)

    check(not errors_before_down, "no page/console errors" + (": " + "; ".join(errors_before_down) if errors_before_down else ""))
    late = [e for e in errors[len(errors_before_down):] if "Failed to load resource" not in e and "ERR_CONNECTION_REFUSED" not in e]
    check(not late, "no page errors while the service was down (the refused fetch is expected)" + (": " + "; ".join(late) if late else ""))
    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all end-to-end checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
