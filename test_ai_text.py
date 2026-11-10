#!/usr/bin/env python3
"""Tests for the AI-written text disclosure markup.

A book marks AI-written words with the exact markup <span class="ai">...</span>, and a
title, summary or Part title can carry an optional display_title / display_summary copy
with the same markup. These tests check that:
  * the HTML and PDF exporters render the markup as <span class="ai-text"> (HTML adds
    visually hidden "AI-written: " text for screen readers; the PDF deliberately does not);
  * look-alike markup (other classes, extra attributes, other quoting) stays escaped text;
  * display copies are used only when they are balanced and strip back to the plain text;
  * a full HTML and EPUB build marks chapter and Part headings, keeps the table of contents
    and EPUB navigation plain, ships the CSS, and still produces well-formed XHTML.

Run:  py test_ai_text.py
"""
import json
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import entropy_to_html
import entropy_to_pdf_v2
import entropy_to_epub

PASS = 0
FAIL = 0


def check(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"ok   {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}" + (f" -- {detail}" if detail else ""))


HTML_OPEN = '<span class="ai-text"><span class="sr-only">AI-written: </span>'
PDF_OPEN = '<span class="ai-text">'

# (markdown, html must contain, pdf must contain, must not contain in either)
INLINE = [
    ('we want <span class="ai">fewer</span> bad eggs',
     HTML_OPEN + 'fewer</span>', PDF_OPEN + 'fewer</span>', ['&lt;span']),
    ('a <span class="ai">**bold** move</span> b',
     HTML_OPEN + '<strong>bold</strong> move</span>', PDF_OPEN + '<strong>bold</strong> move</span>', ['&lt;span']),
    ('a <span class="ai">x</span> and <span style="color: #d64545">y</span>',
     HTML_OPEN + 'x</span>', PDF_OPEN + 'x</span>', ['&lt;span']),
]
REJECTED = [
    'a <span class="ai x">x</span> b',
    'a <span class="AI">x</span> b',
    "a <span class='ai'>x</span> b",
    'a <span class="ai" onclick="alert(1)">x</span> b',
    'a <span  class="ai">x</span> b',
]

for md, h_need, p_need, bad in INLINE:
    h = entropy_to_html.markdown_to_html(md, ".")
    p = entropy_to_pdf_v2.markdown_to_html(md, ".")
    check(f"[html] {md!r}", h_need in h and not any(b in h for b in bad), h)
    check(f"[pdf]  {md!r}", p_need in p and not any(b in p for b in bad) and "sr-only" not in p, p)

for md in REJECTED:
    h = entropy_to_html.markdown_to_html(md, ".")
    p = entropy_to_pdf_v2.markdown_to_html(md, ".")
    check(f"[html] rejected {md!r}", "ai-text" not in h and "&lt;span" in h and "onclick=" not in h.replace("onclick=&quot;", ""), h)
    check(f"[pdf]  rejected {md!r}", "ai-text" not in p and "&lt;span" in p, p)

h = entropy_to_html.markdown_to_html('#### <span class="ai">AI editor\'s note</span>', ".")
check("[html] markup inside a heading", HTML_OPEN in h and h.lstrip().startswith("<h"), h)

# ---- display copies for titles / summaries ----
DISPLAY = [
    # (plain, display, expect_marked)
    ("Don't Be a Bad Egg", 'Don\'t Be a <span class="ai">Bad Egg</span>', True),
    ("Bad Eggs", '<span class="ai">Bad Eggs</span>', True),
    ("A < B", 'A &lt; <span class="ai">B</span>'.replace("&lt;", "<"), True),     # plain text may contain <
    ("Bad Eggs", '<span class="ai">Good Eggs</span>', False),                     # does not strip back to plain
    ("Bad Eggs", '<span class="ai">Bad Eggs', False),                              # unbalanced
    ("Bad Eggs", '<span class="ai"><span class="ai">Bad</span> Eggs</span>', False),  # nested
    ("Bad Eggs", '<b>Bad</b> Eggs', False),                                        # other tags
    ("Bad Eggs", None, False),
    ("Bad Eggs", "", False),
]
for plain, display, marked in DISPLAY:
    for mod, open_ in ((entropy_to_html, HTML_OPEN), (entropy_to_pdf_v2, PDF_OPEN)):
        out = mod.ai_display_html(plain, display)
        name = f"[{mod.__name__.split('_')[-1]}] display {display!r}"
        if marked:
            check(name, open_ in out and "&lt;span" not in out, out)
        else:
            check(name, out == entropy_to_html.esc(plain), out)

out = entropy_to_html.ai_display_html("A < B", 'A < <span class="ai">B</span>')
check("[html] plain '<' stays escaped in a marked title", "A &lt; " in out and HTML_OPEN + "B</span>" in out, out)

# ---- full builds ----
book = {
    "meta": {"title": "AI text test", "author": "Test",
             "structure": {"parts": [{"title": "Bad Eggs", "display_title": '<span class="ai">Bad Eggs</span>',
                                      "nodes": ["ch1", "ch2"]}]}},
    "root": "ch1",
    "nodes": {"ch1": {"id": "ch1", "title": "Don't Be a Bad Egg",
                      "display_title": 'Don\'t Be a <span class="ai">Bad Egg</span>',
                      "summary": "How small errors grow.", "display_summary": '<span class="ai">How small errors grow.</span>',
                      "content": 'To find more golden eggs and <span class="ai">fewer</span> bad eggs.\n\n'
                                 '---\n\n#### <span class="ai">AI editor\'s note</span>\n\n<span class="ai">One word was added.</span>',
                      "children": [], "connections": [], "media": [], "tags": []},
              # a second chapter so the HTML exporter builds a table of contents
              "ch2": {"id": "ch2", "title": "Plain chapter", "content": "Nothing marked here.",
                      "children": [], "connections": [], "media": [], "tags": []}},
}
with tempfile.TemporaryDirectory() as tmp:
    src = Path(tmp) / "book.json"
    src.write_text(json.dumps(book), encoding="utf-8")
    html_path = entropy_to_html.generate_html(src, Path(tmp) / "book.html")
    page = Path(html_path).read_text(encoding="utf-8")
    check("[html build] CSS ships the class", ".ai-text{" in page and "--ai:#b79cff" in page and ".sr-only{" in page)
    check("[html build] chapter heading marked", 'class="node-title">Don&#x27;t Be a ' + HTML_OPEN + "Bad Egg</span>" in page)
    check("[html build] Part heading marked", 'class="part-title">' + HTML_OPEN + "Bad Eggs</span>" in page)
    check("[html build] summary marked", 'class="node-summary">' + HTML_OPEN in page)
    t0 = page.find('<details class="toc"')
    toc = page[t0:page.find("</details>", t0)] if t0 >= 0 else ""
    check("[html build] table of contents stays plain", bool(toc) and "ai-text" not in toc and "Bad Egg" in toc, toc[:300])
    check("[html build] body word marked", HTML_OPEN + "fewer</span>" in page)

    epub_path = entropy_to_epub.build_epub(src, Path(tmp) / "book.epub")
    with zipfile.ZipFile(epub_path) as z:
        names = z.namelist()
        xhtml = {n: z.read(n).decode("utf-8") for n in names if n.endswith(".xhtml")}
        css = next((z.read(n).decode("utf-8") for n in names if n.endswith(".css")), "")
        ncx = "".join(z.read(n).decode("utf-8") for n in names if n.endswith(".ncx"))
    chap = next((v for k, v in xhtml.items() if "fewer" in v), "")
    part = next((v for k, v in xhtml.items() if 'class="part-title"' in v), "")
    nav = "".join(v for k, v in xhtml.items() if "nav" in k.lower()) + ncx
    check("[epub] CSS ships the class", ".ai-text{" in css and ".sr-only{" in css)
    check("[epub] body word marked with screen-reader text", HTML_OPEN + "fewer</span>" in chap, chap[:400])
    check("[epub] chapter heading marked", 'class="node-title">' in chap and HTML_OPEN + "Bad Egg</span>" in chap)
    check("[epub] Part heading marked", HTML_OPEN + "Bad Eggs</span>" in part, part[:300])
    check("[epub] navigation stays plain", bool(nav) and "ai-text" not in nav and "Bad Egg" in nav, nav[:300])
    bad_xml = []
    for k, v in xhtml.items():
        try:
            ET.fromstring(v.encode("utf-8"))
        except ET.ParseError as exc:
            bad_xml.append(f"{k}: {exc}")
    check("[epub] every XHTML document is well-formed", not bad_xml, "; ".join(bad_xml))

print(f"\n{PASS}/{PASS + FAIL} passed")
sys.exit(1 if FAIL else 0)
