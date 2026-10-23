#!/usr/bin/env python3
"""
entropy_to_pdf_v2.py - High-fidelity PDF generator for .entropy.json files.

Unlike entropy_to_pdf.py (which uses fpdf2's limited write_html), this builds a
fully styled, design-system-compliant HTML document and renders it to PDF with a
real browser engine (Playwright Chromium). That gives proper typography, flat
design, color-ramp badges, clickable cross-references, a clickable + page-numbered
table of contents, and a clean unnumbered cover.

Style: "clean editorial light" from the shared design system
  - white background, #2563eb accent
  - sans-serif headings, serif (Georgia) body for comfortable reading
  - flat (no gradients/shadows), two font weights (400 / 500), sentence-case chrome
  - difficulty + connection badges use the design-system 9-ramp palette

Pipeline:
  1. parse json -> depth-first node order
  2. markdown -> HTML (parity with explainer/js/markdown.js + tables)
  3. build standalone HTML (cover doc + main doc: TOC + chapters)
  4. render via Playwright Chromium
  5. two-pass: render once, read the true page of each chapter (PyMuPDF
     named destinations, falling back to invisible markers), re-render with
     real TOC page numbers -- and without the markers, so no hidden text
     reaches the delivered PDF
  6. merge unnumbered cover + numbered body

Usage:
    py entropy_to_pdf_v2.py <input.entropy.json> [output.pdf]
    py entropy_to_pdf_v2.py book.json part1.pdf --sections intro,ch1,ch1a
    py entropy_to_pdf_v2.py book.json part1.pdf --sections-file picked.txt

--sections renders exactly the listed node ids (reading order is kept, nothing
is expanded to sub-sections); the contents page lists only those, Part dividers
survive only with a surviving chapter, chapter numbers are unchanged, and the
back-matter index is left out of a partial export. The same rendering is
available in-process through render_book(data, output, sections=...), which is
what pdf_service.py uses to serve the editor's "Generate PDF" picker.

Requires: playwright (+ chromium), pymupdf
    py -m pip install playwright pymupdf
    py -m playwright install chromium
"""

import argparse
import base64
import html
import json
import mimetypes
import os
import re
import sys
import tempfile
from pathlib import Path


# ---------------------------------------------------------------------------
# Design-system palette (clean editorial light)
# ---------------------------------------------------------------------------
# Difficulty is an ordinal severity scale -> green/amber/coral/purple ramps.
# Each entry: (50-fill, 600-stroke, 800-text) from the design-system ramp table.
DIFFICULTY_RAMP = {
    "intro":        ("#EAF3DE", "#639922", "#27500A"),  # green
    "intermediate": ("#FAEEDA", "#BA7517", "#633806"),  # amber
    "advanced":     ("#FAECE7", "#D85A30", "#712B13"),  # coral
    "expert":       ("#EEEDFE", "#7F77DD", "#3C3489"),  # purple
}

# Connection types -> general-category ramps (blue/amber/purple/teal/pink).
CONNECTION_RAMP = {
    "related":      ("#E6F1FB", "#185FA5", "#042C53"),  # blue
    "prerequisite": ("#FAEEDA", "#BA7517", "#633806"),  # amber
    "deeper":       ("#EEEDFE", "#534AB7", "#26215C"),  # purple
    "example":      ("#E1F5EE", "#0F6E56", "#04342C"),  # teal
    "tangent":      ("#FBEAF0", "#993556", "#4B1528"),  # pink
}

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"}

# Fallback locator: a token embedded invisibly at the top of each chapter so the
# true page it lands on can be read back for the TOC. It is rendered ONLY into
# the first pass (a temp file that is never delivered); the second pass, which
# becomes the actual PDF, is built with marks=False so none of this text reaches
# the reader. Page numbers normally come from named destinations instead.
MARK_PREFIX = "ENTRPGMK"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def esc(text):
    """HTML-escape text (quotes too) for safe insertion into markup/attributes."""
    if text is None:
        return ""
    return html.escape(str(text), quote=True)


_SAFE_STYLE_PROPS = ("color", "background-color", "font-size", "font-family")
_SAFE_STYLE_VALUE = re.compile(r"^[#a-z0-9.,%()\s-]+$", re.I)
# One font family name: a plain word sequence (letters, digits, spaces, hyphens,
# underscores; first character a letter), valid in CSS without quotes.
_FONT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z0-9][A-Za-z0-9_-]*)*$")


def _sanitize_font_family(val):
    """Canonical unquoted "Name, Other Name" list for a font-family value, or "" when any
    name is invalid. Mirrors the editor's sanitizeFontFamily: quotes are stripped and never
    re-emitted, because the persisted <span style="..."> is delimited by double quotes and
    every consumer (editor, reader, HTML/PDF/EPUB) must read it the same way."""
    if not isinstance(val, str) or not val or len(val) > 64:
        return ""
    names = []
    for name in val.split(","):
        name = re.sub(r"\s+", " ", re.sub(r"^[\"']|[\"']$", "", name.strip()).strip())
        if not name or len(name) > 40 or not _FONT_NAME.match(name):
            return ""
        names.append(name)
    return ", ".join(names)


def _sanitize_style(style):
    """Whitelist filter for inline style attributes that the editor persists as raw HTML
    in the markdown (text colour, highlight, relative font size, font family). Mirrors the
    editor's sanitizeInlineStyle: only these properties are honored and each value is held
    to a safe character set, so a hand-edited or pasted style cannot inject script/url() or
    arbitrary CSS. Returns the canonical "prop: value; ..." string, or "" when nothing is
    allowed."""
    if not isinstance(style, str) or not style or len(style) > 200:
        return ""
    out = []
    for decl in style.split(";"):
        if ":" not in decl:
            continue
        prop, val = decl.split(":", 1)
        prop = prop.strip().lower()
        val = val.strip()
        if prop not in _SAFE_STYLE_PROPS:
            continue
        if not val or len(val) > 64:
            continue
        if prop == "font-family":
            fam = _sanitize_font_family(val)
            if fam:
                out.append(f"{prop}: {fam}")
            continue
        if not _SAFE_STYLE_VALUE.match(val):
            continue
        if re.search(r"url|expression|javascript|@import", val, re.I):
            continue
        out.append(f"{prop}: {val}")
    return "; ".join(out)


def sentence_case(label):
    """First letter upper, rest unchanged -> design-system sentence case."""
    if not label:
        return ""
    return label[0].upper() + label[1:]


def _data_uri(path):
    """Return a base64 data URI for a local image, or None if unreadable."""
    try:
        if not path.exists() or not path.is_file():
            return None
        mime, _ = mimetypes.guess_type(str(path))
        if mime is None:
            ext = path.suffix.lower()
            mime = "image/svg+xml" if ext == ".svg" else "image/png"
        with open(path, "rb") as f:
            raw = f.read()
        return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    except Exception:
        return None


def _resolve_src(src, base_dir):
    """
    Resolve an image src to a self-contained value:
      - remote (http/https/data) -> unchanged
      - local (absolute or relative to the json dir) -> base64 data URI
    Returns (resolved_src_or_None, error_message_or_None).
    """
    if not src:
        return None, "empty src"
    if src.startswith(("http://", "https://", "data:")):
        return src, None
    try:
        p = Path(src)
        if not p.is_absolute():
            p = (base_dir / src)
        p = p.resolve()
    except Exception as exc:
        return None, f"bad path: {exc}"
    uri = _data_uri(p)
    if uri is None:
        return None, f"not found: {src}"
    return uri, None


# ---------------------------------------------------------------------------
# Markdown -> HTML  (parity with explainer/js/markdown.js, plus tables)
# ---------------------------------------------------------------------------
def _sanitize_id(s):
    """Namespace anchor ids so several chapters can share one document."""
    s = re.sub(r"[^A-Za-z0-9_-]", "-", str(s if s is not None else ""))
    return s or "fn"


def _harvest_footnote_defs(md):
    """Pull `[^id]: text` definition lines out of the markdown (skipping fenced
    code). Returns (body_without_defs, {id: text}). First definition for an id wins."""
    defs = {}
    if not md:
        return md or "", defs
    body = []
    in_code = False
    def_re = re.compile(r"^\[\^([A-Za-z0-9_-]+)\]:\s?(.*)$")
    for line in md.split("\n"):
        if line.startswith("```"):
            in_code = not in_code
            body.append(line)
            continue
        if not in_code:
            m = def_re.match(line)
            if m:
                fid = m.group(1)
                if fid in defs:
                    sys.stderr.write(f"Footnote: duplicate definition for [^{fid}] ignored.\n")
                else:
                    defs[fid] = m.group(2)
                continue
        body.append(line)
    return "\n".join(body), defs


def _build_notes_section(fn_ctx, defs):
    """Authored-footnote Notes list. Missing and unreferenced definitions are
    surfaced (warned + rendered), never silently dropped."""
    used = fn_ctx["used"]
    prefix = fn_ctx["prefix"]
    base_dir = fn_ctx.get("base_dir")
    referenced = set(fid for _, fid in used)
    orphans = [fid for fid in defs if fid not in referenced]
    if not used and not orphans:
        return ""
    parts = ['<section class="fn-notes" aria-label="Notes">'
             '<h2 class="fn-notes-title">Notes</h2><ol class="fn-notes-list">']
    for n, fid in used:
        if fid in defs:
            inner = _inline(defs[fid], base_dir, None)
            cls = "fn-note-item"
        else:
            sys.stderr.write(f"Footnote [^{fid}] is referenced but has no definition.\n")
            inner = f'<span class="fn-error">[missing footnote text: {esc(fid)}]</span>'
            cls = "fn-note-item fn-error"
        parts.append(
            f'<li id="fn-{prefix}-note-{n}" class="{cls}">'
            f'<span class="fn-note-text">{inner}</span> '
            f'<a class="fn-note-backref" href="#fnref-{prefix}-note-{n}" '
            f'aria-label="Back to note {n}">↩</a></li>'
        )
    for fid in orphans:
        sys.stderr.write(f"Footnote definition [^{fid}] is never referenced.\n")
        inner = _inline(defs[fid], base_dir, None)
        parts.append(
            f'<li class="fn-note-item fn-orphan"><span class="fn-note-text">{inner}</span> '
            f'<span class="fn-orphan-tag">(unreferenced: {esc(fid)})</span></li>'
        )
    parts.append("</ol></section>")
    return "".join(parts)


def _inline(text, base_dir, fn_ctx=None):
    """Escape, then apply inline markdown. Markdown syntax chars survive escaping.

    When fn_ctx is provided, [^id] footnote markers render as bracketed
    superscripts and are collected into fn_ctx for the Notes section."""
    text = esc(text)

    # A few inline HTML tags have no markdown marker, so we restore the specific escaped
    # forms the editor emits (everything else stays escaped literal text). Chromium renders
    # the resulting HTML to PDF, so these display natively:
    #   <u>            underline
    #   <sup>/<sub>    super-/subscript
    #   <span style>   text colour / highlight / relative font size / font family (whitelisted)
    text = re.sub(r"&lt;(/?)u&gt;", r"<\1u>", text)
    text = re.sub(r"&lt;(/?)(sup|sub)&gt;", r"<\1\2>", text)

    def _span(m):
        safe = _sanitize_style(m.group(1))
        return f'<span style="{safe}">' if safe else m.group(0)
    # esc() escapes quotes to &quot;, so the style attribute is delimited by &quot; here.
    text = re.sub(r"&lt;span style=&quot;(.*?)&quot;&gt;", _span, text)
    text = text.replace("&lt;/span&gt;", "</span>")

    # images: ![alt](src)  -> resolved <img>
    # NOTE: src/alt come from `text`, which was already HTML-escaped above, so
    # they must NOT be escaped a second time (that yields &amp;amp; in URLs).
    # A data: URI from _resolve_src contains no HTML-special chars, so leaving
    # it unescaped is safe.
    def _img(m):
        alt = m.group(1)
        resolved, err = _resolve_src(m.group(2), base_dir)
        if resolved is None:
            return f'<span class="media-error">[image {esc(err)}]</span>'
        return f'<img src="{resolved}" alt="{alt}">'
    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", _img, text)

    # authored footnote markers: [^id]  (before links so [^id] isn't read as a label)
    if fn_ctx is not None:
        def _fn(m):
            fid = m.group(1)
            n = fn_ctx["seen"].get(fid)
            if n is None:
                n = len(fn_ctx["used"]) + 1
                fn_ctx["seen"][fid] = n
                fn_ctx["used"].append((n, fid))
            pfx = fn_ctx["prefix"]
            return (f'<sup class="fn-marker" id="fnref-{pfx}-note-{n}">'
                    f'<a href="#fn-{pfx}-note-{n}">[{n}]</a></sup>')
        text = re.sub(r"\[\^([A-Za-z0-9_-]+)\]", _fn, text)

    # links: [text](url)  -- url already escaped once by esc(text); do not re-escape
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>',
        text,
    )

    # Emphasis requires non-space flanking (opener not followed by whitespace, closer not
    # preceded by whitespace) so space-flanked asterisks like "3 * 4 * 5" stay literal,
    # matching the editor's serializer and the reader (explainer/js/markdown.js).
    text = re.sub(r"\*\*\*(?!\s)(.+?)(?<!\s)\*\*\*", r"<strong><em>\1</em></strong>", text)
    text = re.sub(r"\*\*(?!\s)(.+?)(?<!\s)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(?!\s)(.+?)(?<!\s)\*", r"<em>\1</em>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    text = re.sub(r"~~(?!\s)(.+?)(?<!\s)~~", r"<del>\1</del>", text)
    return text


def markdown_to_html(md, base_dir, fn_prefix=None, _fn_ctx=None):
    """Convert a markdown string to HTML. Mirrors the explainer parser.

    When fn_prefix is given, authored footnotes ([^id] markers + [^id]: defs) are
    rendered and an end-of-chapter Notes section is appended. _fn_ctx threads the
    collecting context into recursive example-block parses (one Notes list/node)."""
    owns_ctx = False
    defs = {}
    if _fn_ctx is not None:
        fn_ctx = _fn_ctx
    elif fn_prefix is not None:
        md, defs = _harvest_footnote_defs(md or "")
        fn_ctx = {"prefix": _sanitize_id(fn_prefix), "used": [], "seen": {}, "base_dir": base_dir}
        owns_ctx = True
    else:
        fn_ctx = None

    if not md:
        return _build_notes_section(fn_ctx, defs) if owns_ctx else ""

    lines = md.split("\n")
    out = []
    in_list = False
    list_type = ""
    in_bq = False
    in_code = False
    in_example = False
    example_lines = []
    in_table = False

    def close_list():
        nonlocal in_list, list_type
        if in_list:
            out.append("</ul>" if list_type == "ul" else "</ol>")
            in_list = False

    def close_bq():
        nonlocal in_bq
        if in_bq:
            out.append("</blockquote>")
            in_bq = False

    def close_table():
        nonlocal in_table
        if in_table:
            out.append("</tbody></table>")
            in_table = False

    for line in lines:
        # --- :::example blocks --- (buffer everything until :::, then parse the
        # inner as full markdown; checked BEFORE code/list so nested ``` blocks
        # aren't swallowed by the fenced-code handler below)
        if in_example:
            if re.match(r"^:::\s*$", line):
                inner = markdown_to_html("\n".join(example_lines), base_dir, _fn_ctx=fn_ctx)
                out.append('<div class="example-block"><span class="example-label">Example</span>' + inner + "</div>")
                in_example = False
                example_lines = []
            else:
                example_lines.append(line)
            continue
        if re.match(r"^:::example\s*$", line, re.IGNORECASE):
            close_list(); close_bq(); close_table()
            in_example = True
            example_lines = []
            continue

        # --- fenced code ---
        if line.startswith("```"):
            close_list(); close_bq(); close_table()
            if in_code:
                out.append("</code></pre>")
                in_code = False
            else:
                in_code = True
                out.append("<pre><code>")
            continue
        if in_code:
            out.append(esc(line) + "\n")
            continue

        stripped = line.strip()

        # --- tables (GitHub pipe style) ---
        if "|" in stripped and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if cells and all(re.match(r"^:?-+:?$", c) for c in cells if c):
                continue  # separator row
            if not in_table:
                close_list(); close_bq()
                in_table = True
                out.append(
                    '<table><thead><tr>'
                    + "".join(f"<th>{_inline(c, base_dir, fn_ctx)}</th>" for c in cells)
                    + "</tr></thead><tbody>"
                )
                continue
            out.append("<tr>" + "".join(f"<td>{_inline(c, base_dir, fn_ctx)}</td>" for c in cells) + "</tr>")
            continue
        else:
            close_table()

        # --- close running list / blockquote when pattern ends ---
        if in_list and not re.match(r"^\s*([-*+]|\d+\.)\s", line):
            close_list()
        if in_bq and not line.startswith(">"):
            close_bq()

        # --- headings (content headings start at h2; chapter title is the h1) ---
        m = re.match(r"^(#{1,6})\s+(.+)", line)
        if m:
            close_list(); close_bq()
            level = min(len(m.group(1)) + 1, 6)
            out.append(f"<h{level}>{_inline(m.group(2), base_dir, fn_ctx)}</h{level}>")
            continue

        # --- blockquote ---
        if line.startswith(">"):
            content = re.sub(r"^>\s?", "", line).strip()
            if not in_bq:
                out.append("<blockquote>")
                in_bq = True
            if content:
                out.append(f"<p>{_inline(content, base_dir, fn_ctx)}</p>")
            continue

        # --- unordered list ---
        m = re.match(r"^\s*[-*+]\s+(.+)", line)
        if m:
            if not in_list or list_type != "ul":
                close_list()
                out.append("<ul>")
                in_list = True
                list_type = "ul"
            out.append(f"<li>{_inline(m.group(1), base_dir, fn_ctx)}</li>")
            continue

        # --- ordered list ---
        m = re.match(r"^\s*\d+\.\s+(.+)", line)
        if m:
            if not in_list or list_type != "ol":
                close_list()
                out.append("<ol>")
                in_list = True
                list_type = "ol"
            out.append(f"<li>{_inline(m.group(1), base_dir, fn_ctx)}</li>")
            continue

        # --- horizontal rule ---
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", line):
            out.append("<hr>")
            continue

        # --- blank line ---
        if not stripped:
            continue

        # --- paragraph ---
        out.append(f"<p>{_inline(line, base_dir, fn_ctx)}</p>")

    close_list(); close_bq(); close_table()
    if in_example:
        inner = markdown_to_html("\n".join(example_lines), base_dir, _fn_ctx=fn_ctx)
        out.append('<div class="example-block"><span class="example-label">Example</span>' + inner + "</div>")
    if in_code:
        out.append("</code></pre>")
    if owns_ctx:
        out.append(_build_notes_section(fn_ctx, defs))
    return "".join(out)


# ---------------------------------------------------------------------------
# Tree traversal
# ---------------------------------------------------------------------------
def tree_order(data):
    """Depth-first walk following children arrays. Returns [(node_id, depth), ...]."""
    root_id = data.get("root")
    nodes = data.get("nodes", {})
    order = []
    visited = set()

    def walk(nid, depth):
        if nid in visited or nid not in nodes:
            return
        visited.add(nid)
        order.append((nid, depth))
        for child in nodes[nid].get("children", []):
            walk(child, depth + 1)

    if root_id and root_id in nodes:
        walk(root_id, 0)
    # append any orphan nodes not reachable from root
    for nid in nodes:
        if nid not in visited:
            order.append((nid, 0))
    return order


# ---------------------------------------------------------------------------
# Explicit Part / chapter / epilogue structure (meta.structure)
# ---------------------------------------------------------------------------
_ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"]


def roman(n):
    return _ROMAN[n] if 0 <= n < len(_ROMAN) else str(n)


def structured_items(data):
    """If meta.structure is present, return ordered render items, else None.
    Item kinds: front (unnumbered chapter), part (divider, not a node),
    chapter (numbered), epilogue (unnumbered, labelled)."""
    s = (data.get("meta", {}) or {}).get("structure")
    if not s:
        return None
    items = []
    for nid in s.get("frontmatter", []) or []:
        items.append({"kind": "front", "nid": nid})
    ch = 0
    for i, part in enumerate(s.get("parts", []) or [], start=1):
        items.append({"kind": "part", "num": i, "title": part.get("title", ""), "pid": f"part-{i}"})
        for nid in part.get("nodes", []) or []:
            ch += 1
            items.append({"kind": "chapter", "nid": nid, "num": ch})
    for ep in s.get("epilogues", []) or []:
        items.append({"kind": "epilogue", "nid": ep.get("node"), "title": ep.get("title", "")})
    return items


def ordered_ids(data):
    """Page-mark ids in render order: node ids plus synthetic part ids."""
    items = structured_items(data)
    if items is None:
        return [nid for nid, _ in tree_order(data)]
    ids = [(it["pid"] if it["kind"] == "part" else it["nid"]) for it in items]
    if (data.get("meta", {}) or {}).get("index", {}).get("entries"):
        ids.append("book-index")
    return ids


def apply_selection(data, selection):
    """Restrict a render to an explicit list of node ids (the editor's ticked
    sections). Returns (order, items, ids):
      order  tree_order(data) filtered to the selection, reading order kept
      items  structured_items(data) filtered: chapters / frontmatter / epilogues
             outside the selection are dropped and a Part divider is kept only
             when one of its chapters survives; None when the book has no structure
      ids    page-mark ids in render order (what ordered_ids gives for the whole
             book); the back-matter index is left out of a partial export because
             its page numbers belong to the whole book.
    selection=None means everything, identical to the unfiltered helpers."""
    order = tree_order(data)
    items = structured_items(data)
    if selection is None:
        return order, items, ordered_ids(data)
    wanted = set(selection)
    order = [(nid, depth) for nid, depth in order if nid in wanted]
    if items is None:
        return order, None, [nid for nid, _ in order]
    kept = []
    pending_part = None
    for it in items:
        if it["kind"] == "part":
            pending_part = it
            continue
        if it["nid"] in wanted:
            if pending_part is not None:
                kept.append(pending_part)
                pending_part = None
            kept.append(it)
    ids = [(it["pid"] if it["kind"] == "part" else it["nid"]) for it in kept]
    return order, kept, ids


# ---------------------------------------------------------------------------
# CSS — clean editorial light, design-system compliant
# ---------------------------------------------------------------------------
CSS = """
:root{
  --bg:#ffffff;
  --text:#1a1a1a;
  --text-2:#555555;
  --text-3:#888888;
  --border:#e5e5e5;
  --accent:#2563eb;
  --accent-light:#eff6ff;
  --code-bg:#f4f4f5;
  --pre-bg:#f7f7f8;
  --sans:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif;
  --mono:"Consolas","SFMono-Regular","Liberation Mono",Menlo,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);}
body{
  font-family:var(--serif);
  font-size:15px;
  line-height:1.7;
  font-weight:400;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}
p{margin:0 0 0.85em 0;}
a{color:var(--accent);text-decoration:none;}

/* headings -- match the HTML export: h2/h3 dark sans (600); h4-h6 uppercase accent (700) */
h1,h2,h3,h4,h5,h6{font-family:var(--sans);font-weight:500;line-height:1.3;color:var(--text);}
h2{font-weight:600;font-size:19px;margin:1.4em 0 0.5em;break-after:avoid;}
h3{font-weight:600;font-size:16.5px;margin:1.2em 0 0.45em;break-after:avoid;}
h4,h5,h6{font-weight:700;font-size:15px;letter-spacing:0.09em;text-transform:uppercase;color:var(--accent);margin:1.5em 0 0.5em;break-after:avoid;}

strong{font-weight:500;}
em{font-style:italic;}
del{color:var(--text-3);}

code{
  font-family:var(--mono);font-size:0.86em;background:var(--code-bg);
  padding:1px 5px;border-radius:4px;
}
pre{
  background:var(--pre-bg);border:0.5px solid var(--border);border-radius:8px;
  padding:12px 14px;overflow:auto;break-inside:avoid;margin:0 0 1em;
}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.5;}

blockquote{
  margin:1em 0;padding:0.2em 0 0.2em 16px;border-left:3px solid var(--accent);
  border-radius:0;color:var(--text-2);font-style:italic;
}
blockquote p{margin:0 0 0.4em;}

ul,ol{margin:0 0 0.85em;padding-left:1.5em;}
li{margin:0.2em 0;}

hr{border:none;border-top:0.5px solid var(--border);margin:1.6em 0;}

table{width:100%;border-collapse:collapse;margin:1em 0;font-size:13.5px;}
th,td{border:0.5px solid var(--border);padding:6px 10px;text-align:left;vertical-align:top;}
thead th{background:var(--pre-bg);font-family:var(--sans);font-weight:500;}
tr{break-inside:avoid;}

img{display:block;max-width:100%;height:auto;margin:0.4em auto;border-radius:8px;}
figure{margin:1.2em 0;break-inside:avoid;text-align:center;}
figcaption{font-family:var(--sans);font-size:12px;font-style:italic;color:var(--text-3);margin-top:6px;}
.media-error{font-family:var(--sans);font-size:12px;color:#A32D2D;}
.media-link{
  display:block;font-family:var(--sans);font-size:12.5px;color:var(--text-2);
  border:0.5px solid var(--border);border-radius:8px;padding:10px 12px;margin:1em 0;
}
.media-link .mtype{color:var(--accent);font-weight:500;margin-right:6px;}

/* authored footnotes (end-of-chapter Notes) */
.fn-marker{font-size:.72em;font-weight:600;line-height:0;vertical-align:super;white-space:nowrap;}
.fn-marker a{color:var(--accent);text-decoration:none;}
.fn-notes{margin-top:1.8em;padding-top:.9em;border-top:0.5px solid var(--border);break-inside:auto;}
.fn-notes-title{font-family:var(--sans);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin:0 0 .6em;}
.fn-notes-list{margin:0;padding-left:1.5em;}
.fn-note-item{font-size:.9em;color:var(--text-2);line-height:1.5;break-inside:avoid;margin:.3em 0;}
.fn-note-backref{color:var(--text-3);text-decoration:none;margin-left:.3em;}
.fn-error{color:#A32D2D;}
.fn-orphan{color:var(--text-3);font-style:italic;}
.fn-orphan-tag{font-size:.78em;color:var(--text-3);}

.example-block{
  background:var(--accent-light);border-left:3px solid var(--accent);border-radius:0;
  padding:10px 16px;margin:1em 0;break-inside:avoid;
}
.example-block .example-label{
  display:block;font-family:var(--sans);font-size:11px;font-weight:500;
  color:var(--accent);margin-bottom:4px;
}
.example-block p:last-child{margin-bottom:0;}

/* ---- cover ---- */
.cover{
  display:flex;flex-direction:column;justify-content:center;align-items:center;
  text-align:center;min-height:9.0in;padding:0 0.9in;
}
.cover .title{font-family:var(--sans);font-weight:500;font-size:42px;line-height:1.15;color:var(--text);margin:0;}
.cover .subtitle{font-family:var(--serif);font-style:italic;font-size:20px;color:var(--text-2);margin:18px 0 0;}
.cover .rule{width:64px;height:3px;background:var(--accent);border:none;margin:30px 0;}
.cover .author{font-family:var(--sans);font-size:16px;color:var(--text);margin:0;}
.cover .desc{font-family:var(--serif);font-size:14px;color:var(--text-2);max-width:5.2in;margin:22px auto 0;line-height:1.6;}
.cover .stamp{font-family:var(--sans);font-size:11px;color:var(--text-3);margin-top:34px;}
.cover .tags{font-family:var(--sans);font-size:11px;color:var(--text-3);margin-top:8px;}

/* ---- table of contents ---- */
.toc h1{font-family:var(--sans);font-weight:500;font-size:26px;margin:0 0 22px;}
.toc-entry{
  display:flex;align-items:baseline;gap:0;font-family:var(--sans);font-size:13.5px;
  margin:4px 0;line-height:1.5;
}
.toc-entry.depth-0{font-size:14.5px;margin-top:12px;}
.toc-entry .dot{
  flex:none;width:8px;height:8px;border-radius:50%;margin-right:9px;
  align-self:center;border:0.5px solid rgba(0,0,0,0.15);
}
.toc-entry .toc-title{color:var(--accent);}
.toc-entry.depth-0 .toc-title{font-weight:500;}
.toc-entry .leader{
  flex:1;border-bottom:1px dotted var(--border);margin:0 6px;transform:translateY(-3px);min-width:14px;
}
.toc-entry .page{
  flex:none;font-variant-numeric:tabular-nums;min-width:2.6ch;text-align:right;color:var(--text-2);
}
.toc-legend{margin-top:26px;padding-top:14px;border-top:0.5px solid var(--border);
  font-family:var(--sans);font-size:11px;color:var(--text-3);}
.toc-legend .item{display:inline-flex;align-items:center;margin-right:18px;}
.toc-legend .dot{width:8px;height:8px;border-radius:50%;margin-right:6px;border:0.5px solid rgba(0,0,0,0.15);}

/* ---- chapters ---- */
.chapter{position:relative;break-before:page;}
.chapter:first-of-type{break-before:auto;}
.pagemark{position:absolute;left:0;top:0;font-size:4px;color:#ffffff;user-select:none;}
.chapter-title{
  font-family:var(--sans);font-weight:500;font-size:28px;line-height:1.2;
  margin:0 0 6px;color:var(--text);
}
.chapter.depth-1 .chapter-title{font-size:24px;}
.chapter.depth-2 .chapter-title{font-size:21px;}
.chapter.depth-3 .chapter-title,.chapter.depth-4 .chapter-title,
.chapter.depth-5 .chapter-title{font-size:18px;}

.meta-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 6px;}
.badge{
  display:inline-block;font-family:var(--sans);font-size:10.5px;font-weight:500;
  padding:2px 9px;border-radius:11px;border:0.5px solid;line-height:1.5;
}
.meta-time,.meta-tag{font-family:var(--sans);font-size:11px;color:var(--text-3);}
.meta-tag::before{content:"#";opacity:0.5;}

.chapter-summary{
  font-family:var(--serif);font-style:italic;font-size:16px;color:var(--text-2);
  margin:6px 0 0;line-height:1.55;
}
.title-rule{border:none;border-top:2px solid var(--accent);width:54px;margin:14px 0 18px;}

.chapter-body{}

/* ---- footer sections: See also / In this section ---- */
.relations{margin-top:24px;padding-top:14px;border-top:0.5px solid var(--border);break-inside:avoid;}
.relations h4{
  font-family:var(--sans);font-size:12px;font-weight:500;color:var(--text-2);
  margin:0 0 8px;text-transform:none;
}
.relations + .relations{margin-top:16px;border-top:none;padding-top:0;}
.rel-item{display:flex;align-items:baseline;gap:8px;margin:5px 0;font-family:var(--sans);font-size:13px;}
.rel-type{
  flex:none;font-size:9.5px;font-weight:500;padding:1px 7px;border-radius:9px;border:0.5px solid;line-height:1.5;
}
.rel-link{color:var(--accent);}
.rel-bullet{color:var(--text-3);flex:none;}

/* ---- parts, chapter numbers, epilogues ---- */
.part-divider{position:relative;break-before:page;display:flex;flex-direction:column;justify-content:center;
  min-height:7.6in;text-align:center;}
.part-eyebrow{font-family:var(--sans);font-size:13px;font-weight:500;letter-spacing:0.24em;
  text-transform:uppercase;color:var(--accent);margin:0 0 14px;}
.part-title{font-family:var(--sans);font-weight:500;font-size:40px;line-height:1.15;margin:0;color:var(--text);}
.chapter-num{font-family:var(--sans);font-size:12px;font-weight:500;letter-spacing:0.18em;
  text-transform:uppercase;color:var(--accent);margin:0 0 4px;}
.chapter-num.chapter-ep{color:var(--text-3);}
.toc-part{display:flex;align-items:baseline;font-family:var(--sans);font-size:15px;font-weight:500;margin:18px 0 5px;}
.toc-part .toc-part-label{flex:none;font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;
  color:var(--accent);margin-right:11px;align-self:center;}
.toc-part .leader{flex:1;border-bottom:1px dotted var(--border);margin:0 8px;transform:translateY(-3px);min-width:14px;}
.toc-part .page{flex:none;font-variant-numeric:tabular-nums;min-width:2.6ch;text-align:right;color:var(--text-2);}
.toc-num{flex:none;min-width:2.4ch;color:var(--text-3);font-variant-numeric:tabular-nums;
  margin-right:9px;font-family:var(--sans);font-size:13px;text-align:right;}
.toc-num.toc-ep{min-width:auto;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;}
.toc-entry.toc-front{margin-top:6px;}

/* ---- back-matter index ---- */
.backmatter-index{position:relative;break-before:page;}
.index-list{columns:2;column-gap:30px;font-family:var(--sans);font-size:11px;line-height:1.5;
  margin-top:6px;}
.idx-entry{break-inside:avoid;margin:3px 0;color:var(--text-2);}
.idx-term{color:var(--text);font-weight:500;}
.idx-ch{color:var(--accent);}
.idx-ch.idx-main{font-weight:700;}
.idx-pg{color:var(--text-3);}
.idx-loc{font-style:italic;color:var(--text-3);}
.idx-see{color:var(--text-3);font-style:italic;}
.index-note{font-family:var(--sans);font-size:10.5px;color:var(--text-3);margin:2px 0 0;font-style:italic;}
"""


# ---------------------------------------------------------------------------
# HTML builders
# ---------------------------------------------------------------------------
def _badge_style(ramp):
    fill, stroke, text = ramp
    return f"background:{fill};border-color:{stroke};color:{text};"


def build_cover_html(meta):
    title = esc(meta.get("title", "Untitled"))
    parts = ['<!DOCTYPE html><html><head><meta charset="utf-8"><style>', CSS, "</style></head><body>"]
    parts.append('<div class="cover">')
    parts.append(f'<h1 class="title">{title}</h1>')
    if meta.get("subtitle"):
        parts.append(f'<p class="subtitle">{esc(meta["subtitle"])}</p>')
    parts.append('<hr class="rule">')
    if meta.get("author"):
        parts.append(f'<p class="author">{esc(meta["author"])}</p>')
    if meta.get("description"):
        parts.append(f'<p class="desc">{esc(meta["description"])}</p>')

    stamp_bits = []
    # version number intentionally not rendered (internal tracking only)
    if meta.get("modified"):
        stamp_bits.append(esc(str(meta["modified"])[:10]))
    if stamp_bits:
        parts.append(f'<p class="stamp">{"  ·  ".join(stamp_bits)}</p>')
    if meta.get("tags"):
        parts.append(f'<p class="tags">{esc(", ".join(meta["tags"]))}</p>')
    parts.append("</div></body></html>")
    return "".join(parts)


def _meta_bar(node):
    bits = []
    diff = node.get("difficulty")
    if diff in DIFFICULTY_RAMP:
        bits.append(f'<span class="badge" style="{_badge_style(DIFFICULTY_RAMP[diff])}">{esc(sentence_case(diff))}</span>')
    elif diff:
        bits.append(f'<span class="meta-tag">{esc(diff)}</span>')
    if node.get("estimatedTime"):
        bits.append(f'<span class="meta-time">{esc(node["estimatedTime"])}</span>')
    for tag in node.get("tags", []) or []:
        bits.append(f'<span class="meta-tag">{esc(tag)}</span>')
    if not bits:
        return ""
    return '<div class="meta-bar">' + "".join(bits) + "</div>"


def _media_html(node, base_dir):
    out = []
    for item in node.get("media", []) or []:
        mtype = item.get("type", "")
        src = item.get("src", "")
        caption = item.get("caption") or item.get("alt") or ""
        if mtype in ("image", "diagram"):
            resolved, err = _resolve_src(src, base_dir)
            if resolved is None:
                out.append(f'<p class="media-error">[image {esc(err)}]</p>')
                continue
            cap = f'<figcaption>{esc(caption)}</figcaption>' if caption else ""
            out.append(f'<figure><img src="{esc(resolved)}" alt="{esc(item.get("alt",""))}">{cap}</figure>')
        elif mtype in ("video", "audio", "embed"):
            label = caption or src
            href = esc(src) if src.startswith(("http://", "https://")) else ""
            inner = f'<a href="{href}">{esc(label)}</a>' if href else esc(label)
            out.append(f'<div class="media-link"><span class="mtype">{esc(sentence_case(mtype))}</span>{inner}</div>')
    return "".join(out)


def _relations_html(node, nodes, rendered=None):
    """rendered: set of node ids present in this document (None = all of them).
    A cross-reference to a section that is not in the document (a partial export)
    is shown as plain text rather than a link with nowhere to go."""
    out = []
    connections = node.get("connections", []) or []
    children = node.get("children", []) or []

    if connections:
        rows = []
        for conn in connections:
            tid = conn.get("to", "")
            ctype = conn.get("type", "related")
            label = conn.get("label") or nodes.get(tid, {}).get("title", tid)
            ramp = CONNECTION_RAMP.get(ctype, CONNECTION_RAMP["related"])
            type_badge = f'<span class="rel-type" style="{_badge_style(ramp)}">{esc(sentence_case(ctype))}</span>'
            if tid in nodes and (rendered is None or tid in rendered):
                link = f'<a class="rel-link" href="#node-{esc(tid)}">{esc(label)}</a>'
            else:
                link = f'<span>{esc(label)}</span>'
            rows.append(f'<div class="rel-item">{type_badge}{link}</div>')
        out.append('<div class="relations"><h4>See also</h4>' + "".join(rows) + "</div>")

    # "In this section" (child list) intentionally omitted — the book uses an
    # explicit Part/chapter structure, so the per-chapter child list is redundant.
    return "".join(out)


def _chapter_section(parts, node, nid, base_dir, nodes, num_html="", rendered=None,
                     marks=True):
    parts.append(f'<section class="chapter" id="node-{esc(nid)}">')
    if marks:
        parts.append(f'<span class="pagemark">{MARK_PREFIX}{esc(nid)}{MARK_PREFIX}</span>')
    if num_html:
        parts.append(num_html)
    parts.append(f'<h1 class="chapter-title">{esc(node.get("title", nid))}</h1>')
    parts.append(_meta_bar(node))
    if node.get("summary"):
        parts.append(f'<p class="chapter-summary">{esc(node["summary"])}</p>')
    parts.append('<hr class="title-rule">')
    body = markdown_to_html(node.get("content", ""), base_dir, fn_prefix=_sanitize_id(nid))
    parts.append(f'<div class="chapter-body">{body}</div>')
    parts.append(_media_html(node, base_dir))
    parts.append(_relations_html(node, nodes, rendered))
    parts.append("</section>")


def _index_html(data, for_pdf=True, marks=True):
    """Render the back-matter Index from meta.index (chapter refs + page numbers)."""
    idx = (data.get("meta", {}) or {}).get("index")
    if not idx or not idx.get("entries"):
        return ""
    num_to_nid = {}
    for it in (structured_items(data) or []):
        if it["kind"] == "chapter":
            num_to_nid[it["num"]] = it["nid"]
    out = ['<section class="backmatter-index" id="book-index">']
    if for_pdf and marks:
        out.append(f'<span class="pagemark">{MARK_PREFIX}book-index{MARK_PREFIX}</span>')
    out.append('<h1 class="chapter-title">Index</h1>')
    out.append('<hr class="title-rule">')
    out.append('<div class="index-list">')
    for e in idx["entries"]:
        term = f'<a class="idx-term" href="#node-{esc(e["primary_nid"])}">{esc(e["term"])}</a>'
        if e.get("passim"):
            locs = '<span class="idx-loc">throughout</span>'
        else:
            refs = []
            for n in e.get("chapters", []):
                nid = num_to_nid.get(n)
                cls = "idx-ch idx-main" if n == e.get("primary_ch") else "idx-ch"
                refs.append(f'<a class="{cls}" href="#node-{esc(nid)}">Ch {n}</a>' if nid
                            else f'<span class="{cls}">Ch {n}</span>')
            locs = " ".join(refs)
            pages = e.get("pages", []) or []
            if pages:
                pp = ", ".join(f'<strong>{p}</strong>' if p == e.get("primary_page") else str(p) for p in pages)
                lbl = "p." if len(pages) == 1 else "pp."
                locs += f' <span class="idx-pg">&middot; {lbl}&nbsp;{pp}</span>'
        see = f' <span class="idx-see">&mdash; {esc(e["see"])}</span>' if e.get("see") else ""
        out.append(f'<div class="idx-entry">{term} {locs}{see}</div>')
    out.append("</div></section>")
    return "".join(out)


def build_main_html(data, base_dir, order, page_map=None, selection=None, marks=True):
    """page_map: {id: int} for TOC page numbers, or None (placeholder pass).
    selection: explicit node ids to render (see apply_selection); when given it
    overrides `order` and the back-matter index is omitted.
    marks: emit the invisible ENTRPGMK page markers. They exist only so the
    first pass can be measured; the delivered PDF is rendered with marks=False
    so no marker text reaches the reader's text layer (see render_book)."""
    nodes = data.get("nodes", {})
    items = structured_items(data)
    include_index = True
    rendered = None      # ids present in this document; None = whole book
    if selection is not None:
        order, items, _ = apply_selection(data, selection)
        include_index = False
        rendered = (set(it["nid"] for it in items if it["kind"] != "part") if items is not None
                    else set(nid for nid, _ in order))
    parts = ['<!DOCTYPE html><html><head><meta charset="utf-8"><style>', CSS, "</style></head><body>"]

    def _pg(idv):
        return str(page_map.get(idv, "")) if page_map is not None else ""

    # ---- Table of contents ----
    parts.append('<section class="toc">')
    parts.append("<h1>Table of contents</h1>")
    if items is not None:
        for it in items:
            if it["kind"] == "part":
                parts.append(
                    f'<div class="toc-part"><span class="toc-part-label">Part {roman(it["num"])}</span>'
                    f'<a class="toc-title" href="#{it["pid"]}">{esc(it["title"])}</a>'
                    f'<span class="leader"></span><span class="page">{_pg(it["pid"])}</span></div>'
                )
                continue
            nid = it["nid"]
            title = nodes.get(nid, {}).get("title", nid)
            if it["kind"] == "chapter":
                num, cls = f'<span class="toc-num">{it["num"]}</span>', "toc-chapter"
            elif it["kind"] == "epilogue":
                num, cls = '<span class="toc-num toc-ep">Epil.</span>', "toc-epilogue"
            else:
                num, cls = '<span class="toc-num"></span>', "toc-front"
            parts.append(
                f'<div class="toc-entry {cls}">{num}'
                f'<a class="toc-title" href="#node-{esc(nid)}">{esc(title)}</a>'
                f'<span class="leader"></span><span class="page">{_pg(nid)}</span></div>'
            )
    else:
        for nid, depth in order:
            node = nodes.get(nid, {})
            title = node.get("title", nid)
            diff = node.get("difficulty")
            if diff in DIFFICULTY_RAMP:
                dot = f'<span class="dot" style="background:{DIFFICULTY_RAMP[diff][1]};"></span>'
            else:
                dot = '<span class="dot" style="background:transparent;border-color:transparent;"></span>'
            parts.append(
                f'<div class="toc-entry depth-{depth}" style="padding-left:{depth*16}px">'
                f'{dot}<a class="toc-title" href="#node-{esc(nid)}">{esc(title)}</a>'
                f'<span class="leader"></span><span class="page">{_pg(nid)}</span></div>'
            )

    # difficulty legend (only for difficulties actually present)
    present = []
    for nid, _ in order:
        d = nodes.get(nid, {}).get("difficulty")
        if d in DIFFICULTY_RAMP and d not in present:
            present.append(d)
    if present:
        legend = []
        for d in ["intro", "intermediate", "advanced", "expert"]:
            if d in present:
                legend.append(
                    f'<span class="item"><span class="dot" style="background:{DIFFICULTY_RAMP[d][1]};"></span>{esc(sentence_case(d))}</span>'
                )
        parts.append('<div class="toc-legend">' + "".join(legend) + "</div>")
    if include_index and items is not None and (data.get("meta", {}) or {}).get("index", {}).get("entries"):
        parts.append(
            f'<div class="toc-part" style="margin-top:18px;"><span class="toc-part-label">Back</span>'
            f'<a class="toc-title" href="#book-index">Index</a>'
            f'<span class="leader"></span><span class="page">{_pg("book-index")}</span></div>'
        )
    parts.append("</section>")

    # ---- Chapters ----
    if items is not None:
        for it in items:
            if it["kind"] == "part":
                parts.append(f'<section class="part-divider" id="{it["pid"]}">')
                if marks:
                    parts.append(f'<span class="pagemark">{MARK_PREFIX}{it["pid"]}{MARK_PREFIX}</span>')
                parts.append(f'<div class="part-eyebrow">Part {roman(it["num"])}</div>')
                parts.append(f'<h1 class="part-title">{esc(it["title"])}</h1>')
                parts.append("</section>")
                continue
            nid = it["nid"]
            node = nodes.get(nid, {})
            if it["kind"] == "chapter":
                num_html = f'<div class="chapter-num">Chapter {it["num"]}</div>'
            elif it["kind"] == "epilogue":
                num_html = '<div class="chapter-num chapter-ep">Epilogue</div>'
            else:
                num_html = ""
            _chapter_section(parts, node, nid, base_dir, nodes, num_html, rendered=rendered,
                             marks=marks)
    else:
        for nid, depth in order:
            node = nodes.get(nid, {})
            parts.append(f'<section class="chapter depth-{depth}" id="node-{esc(nid)}">')
            if marks:
                parts.append(f'<span class="pagemark">{MARK_PREFIX}{esc(nid)}{MARK_PREFIX}</span>')
            parts.append(f'<h1 class="chapter-title">{esc(node.get("title", nid))}</h1>')
            parts.append(_meta_bar(node))
            if node.get("summary"):
                parts.append(f'<p class="chapter-summary">{esc(node["summary"])}</p>')
            parts.append('<hr class="title-rule">')
            body = markdown_to_html(node.get("content", ""), base_dir, fn_prefix=_sanitize_id(nid))
            parts.append(f'<div class="chapter-body">{body}</div>')
            parts.append(_media_html(node, base_dir))
            parts.append(_relations_html(node, nodes, rendered))
            parts.append("</section>")

    if include_index:
        parts.append(_index_html(data, for_pdf=True, marks=marks))
    parts.append("</body></html>")
    return "".join(parts)


# ---------------------------------------------------------------------------
# Rendering (Playwright Chromium)
# ---------------------------------------------------------------------------
def _render_pdf(playwright, html_str, out_path, with_footer, book_title):
    browser = playwright.chromium.launch()
    try:
        page = browser.new_page()
        page.set_content(html_str, wait_until="load")
        page.emulate_media(media="print")
        kwargs = dict(
            path=str(out_path),
            format="Letter",
            print_background=True,
            margin={"top": "20mm", "bottom": "18mm", "left": "22mm", "right": "22mm"},
        )
        if with_footer:
            header = (
                '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:8px;color:#bbbbbb;'
                'width:100%;padding:0 22mm;text-align:right;">' + esc(book_title) + "</div>"
            )
            footer = (
                '<div style="font-family:Segoe UI,Arial,sans-serif;font-size:9px;color:#999999;'
                'width:100%;text-align:center;"><span class="pageNumber"></span></div>'
            )
            kwargs.update(display_header_footer=True, header_template=header, footer_template=footer)
        else:
            kwargs.update(display_header_footer=False)
        page.pdf(**kwargs)
    finally:
        browser.close()


def _dest_pages(pdf_path, ids):
    """Return {node_id: 1-based page number} from the PDF's named destinations.

    Chromium emits a named destination for every element id it renders, so a
    section can be located without putting anything in the text layer: chapters
    carry `node-<id>`, part dividers and the back-matter index carry their bare
    id. Returns {} when the PyMuPDF build has no resolve_names(), so the caller
    can fall back to the marker scan."""
    import fitz
    if not ids:
        return {}
    page_of = {}
    try:
        doc = fitz.open(str(pdf_path))
    except Exception:
        return {}
    try:
        if not hasattr(doc, "resolve_names"):
            return {}
        try:
            names = doc.resolve_names() or {}
        except Exception:
            return {}
        if not isinstance(names, dict):
            return {}
        n_pages = doc.page_count
        for nid in ids:
            for key in (f"node-{nid}", str(nid)):
                entry = names.get(key)
                if not isinstance(entry, dict):
                    continue
                pno = entry.get("page")
                if isinstance(pno, int) and 0 <= pno < n_pages:
                    page_of[nid] = pno + 1
                    break
    finally:
        doc.close()
    return page_of


def _resolve_pages(pdf_path, ids):
    """Locate every section's start page in the pass-1 PDF.

    Named destinations first (they leave the text layer clean); anything they
    miss falls back to the invisible marker scan, which is why pass 1 still
    renders the markers."""
    page_of = _dest_pages(pdf_path, ids)
    missing = [nid for nid in ids if nid not in page_of]
    if missing:
        page_of.update(_marker_pages(pdf_path, missing))
    return page_of


def _marker_pages(pdf_path, ids):
    """Return {node_id: 1-based page number} by locating invisible markers via PyMuPDF."""
    import fitz
    page_of = {}
    doc = fitz.open(str(pdf_path))
    try:
        # build per-page collapsed text once
        page_texts = []
        for pg in doc:
            txt = pg.get_text("text")
            page_texts.append(re.sub(r"\s+", "", txt))
        for nid in ids:
            token = f"{MARK_PREFIX}{nid}{MARK_PREFIX}"
            for i, txt in enumerate(page_texts):
                if token in txt:
                    page_of[nid] = i + 1
                    break
    finally:
        doc.close()
    return page_of


def _convert_named_links(doc):
    """
    Chromium emits in-document anchor links as *named* destinations, which fitz
    drops during insert_pdf. Convert them to explicit GOTO links (fitz already
    resolves the target page) so they survive the merge and stay clickable.
    """
    import fitz
    converted = 0
    for pg in doc:
        for l in list(pg.get_links()):
            if l.get("kind") == fitz.LINK_NAMED and l.get("page", -1) >= 0:
                pg.delete_link(l)
                pg.insert_link({
                    "kind": fitz.LINK_GOTO,
                    "from": l["from"],
                    "page": l["page"],
                    # Land at the TOP of the target page. The named dest's "to" comes
                    # back from get_links() in top-left page coords; round-tripping it
                    # through insert_link flips it to the page BOTTOM, so links appeared
                    # to jump one page forward. Point(0, 0) is unambiguously the top.
                    "to": fitz.Point(0, 0),
                })
                converted += 1
    return converted


def _merge(cover_pdf, main_pdf, out_path):
    """Prepend the unnumbered cover to the numbered body, preserving links."""
    import fitz
    final = fitz.open()
    main = fitz.open(str(main_pdf))
    try:
        _convert_named_links(main)
        with fitz.open(str(cover_pdf)) as c:
            final.insert_pdf(c)
        final.insert_pdf(main)
        # Page labels so a viewer's page counter matches the printed footers (and
        # the index): the cover is unnumbered, then decimal 1..N from the contents
        # page onward -- i.e. viewer page == book page.
        try:
            final.set_page_labels([
                {"startpage": 0, "prefix": "", "style": ""},
                {"startpage": 1, "prefix": "", "style": "D", "firstpagenum": 1},
            ])
        except Exception:
            pass  # older PyMuPDF without set_page_labels -> skip gracefully
        final.save(str(out_path))
    finally:
        main.close()
        final.close()


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def validate_selection(data, sections):
    """Check an explicit section list against the book. Returns the list unchanged
    (None means the whole book); raises ValueError with a reader-facing message."""
    if sections is None:
        return None
    if not isinstance(sections, (list, tuple)) or not all(isinstance(x, str) for x in sections):
        raise ValueError("sections must be a list of node ids")
    if not sections:
        raise ValueError("no sections selected")
    nodes = data.get("nodes", {}) or {}
    unknown = [x for x in sections if x not in nodes]
    if unknown:
        shown = ", ".join(unknown[:5]) + (" ..." if len(unknown) > 5 else "")
        raise ValueError(f"unknown section id(s): {shown}")
    return list(sections)


def render_book(data, output_path, base_dir=None, sections=None, log=print,
                page_marks=False):
    """Render an in-memory book to output_path (cover + numbered body).

    data        parsed .entropy.json (dict)
    base_dir    folder that relative image paths in the book resolve against
                (default: current directory)
    sections    explicit node ids to render, or None for the whole book
    log         callable for progress lines
    page_marks  keep the invisible ENTRPGMK markers in the delivered PDF.
                Off by default so nothing hidden reaches the reader; turn it
                on only for tooling that scrapes them to map pages to
                chapters (the glossary/index builder). The clickable contents
                links carry the same information without hidden text.

    Raises ValueError for unusable input (checked before any browser starts) and
    RuntimeError when Playwright is not installed. Returns the Path actually
    written: a sibling "<name>_new.pdf" when the target is locked by a viewer."""
    if not isinstance(data, dict) or not isinstance(data.get("nodes"), dict):
        raise ValueError("not a valid .entropy.json (missing 'nodes')")
    meta = data.get("meta", {}) or {}
    if not isinstance(meta, dict):
        raise ValueError("'meta' must be an object")
    nodes = data["nodes"]
    if not nodes:
        raise ValueError("no nodes to render")
    sections = validate_selection(data, sections)
    base_dir = Path(base_dir) if base_dir else Path.cwd()
    output_path = Path(output_path).resolve()
    book_title = meta.get("title", "Untitled")
    order, _items, ids = apply_selection(data, sections)
    if not ids:
        raise ValueError("the selection contains no section that this book renders")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError(
            "Playwright is required. Install with:\n"
            "  py -m pip install playwright pymupdf\n"
            "  py -m playwright install chromium"
        )

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        cover_pdf = tmp / "cover.pdf"
        main_pass1 = tmp / "main_p1.pdf"
        main_pass2 = tmp / "main_p2.pdf"

        cover_html = build_cover_html(meta)
        main_html_1 = build_main_html(data, base_dir, order, page_map=None, selection=sections)

        with sync_playwright() as pw:
            log("Rendering cover ...")
            _render_pdf(pw, cover_html, cover_pdf, with_footer=False, book_title=book_title)

            log("Rendering body (pass 1 of 2) ...")
            _render_pdf(pw, main_html_1, main_pass1, with_footer=True, book_title=book_title)

            page_map = _resolve_pages(main_pass1, ids)
            missing = [nid for nid in ids if nid not in page_map]
            if missing:
                log(f"  Note: page number not located for {len(missing)} node(s); leaving blank.")

            log("Rendering body (pass 2 of 2) ...")
            # marks=False: the markers did their job in pass 1 (a temp file that is
            # never delivered). They are position:absolute, so dropping them cannot
            # move any content and the pass-1 page numbers stay valid.
            main_html_2 = build_main_html(data, base_dir, order, page_map=page_map,
                                          selection=sections, marks=page_marks)
            _render_pdf(pw, main_html_2, main_pass2, with_footer=True, book_title=book_title)

        log("Merging cover + body ...")
        try:
            _merge(cover_pdf, main_pass2, output_path)
        except Exception as exc:
            # output likely locked (open in a viewer) -> write a sibling file
            alt = output_path.with_stem(output_path.stem + "_new")
            log(f"  Could not write {output_path.name} ({exc}); writing {alt.name} instead.")
            _merge(cover_pdf, main_pass2, alt)
            output_path = alt

    log(f"\nPDF generated: {output_path}")
    log(f"  Nodes: {len(order)}")
    return output_path


def generate_pdf(json_path, output_path=None, sections=None, page_marks=False):
    """CLI entry: read the book file, render (whole book or --sections), exit 1 on errors."""
    json_path = Path(json_path).resolve()
    if not json_path.exists():
        print(f"Error: file not found: {json_path}")
        sys.exit(1)

    try:
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"Error: could not read JSON: {exc}")
        sys.exit(1)

    if output_path is None:
        output_path = json_path.with_suffix(".pdf")

    try:
        return render_book(data, output_path, base_dir=json_path.parent, sections=sections,
                           page_marks=page_marks)
    except ValueError as exc:
        print(f"Error: {exc}.")
        sys.exit(1)
    except RuntimeError as exc:
        print(exc)
        sys.exit(1)


def _read_sections_file(path):
    """One node id per line, or a JSON array of ids. Blank lines and # comments ignored."""
    text = Path(path).read_text(encoding="utf-8")
    stripped = text.strip()
    if stripped.startswith("["):
        ids = json.loads(stripped)
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
            raise ValueError("sections file: JSON array must contain only strings")
        return ids
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Render an .entropy.json book (or a selection of its sections) to PDF.")
    ap.add_argument("input", help="book .entropy.json")
    ap.add_argument("output", nargs="?", help="output .pdf (default: next to the input)")
    ap.add_argument("--sections", help="comma-separated node ids to render, exactly these")
    ap.add_argument("--sections-file", help="file with one node id per line, or a JSON array")
    ap.add_argument("--page-marks", action="store_true",
                    help="keep the invisible page markers in the output (needed only by "
                         "tooling that scrapes them; the delivered PDF is clean without it)")
    args = ap.parse_args()

    picked = None
    if args.sections and args.sections_file:
        ap.error("use --sections or --sections-file, not both")
    if args.sections:
        picked = [x.strip() for x in args.sections.split(",") if x.strip()]
    elif args.sections_file:
        try:
            picked = _read_sections_file(args.sections_file)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            ap.error(f"could not read --sections-file: {exc}")
    generate_pdf(args.input, args.output, sections=picked, page_marks=args.page_marks)
