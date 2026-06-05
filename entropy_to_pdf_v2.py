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
  5. two-pass: render once, read the true page of each chapter (PyMuPDF),
     re-render with real TOC page numbers
  6. merge unnumbered cover + numbered body

Usage:
    py entropy_to_pdf_v2.py <input.entropy.json> [output.pdf]

Requires: playwright (+ chromium), pymupdf
    py -m pip install playwright pymupdf
    py -m playwright install chromium
"""

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

# Token embedded (invisibly) at the top of each chapter so the true page each
# chapter lands on can be read back from the rendered PDF for the TOC.
MARK_PREFIX = "ENTRPGMK"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def esc(text):
    """HTML-escape text (quotes too) for safe insertion into markup/attributes."""
    if text is None:
        return ""
    return html.escape(str(text), quote=True)


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
def _inline(text, base_dir):
    """Escape, then apply inline markdown. Markdown syntax chars survive escaping."""
    text = esc(text)

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

    # links: [text](url)  -- url already escaped once by esc(text); do not re-escape
    text = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        lambda m: f'<a href="{m.group(2)}">{m.group(1)}</a>',
        text,
    )

    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"\*(.+?)\*", r"<em>\1</em>", text)
    text = re.sub(r"`(.+?)`", r"<code>\1</code>", text)
    text = re.sub(r"~~(.+?)~~", r"<del>\1</del>", text)
    return text


def markdown_to_html(md, base_dir):
    """Convert a markdown string to HTML. Mirrors the explainer parser."""
    if not md:
        return ""

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
                inner = markdown_to_html("\n".join(example_lines), base_dir)
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
                    + "".join(f"<th>{_inline(c, base_dir)}</th>" for c in cells)
                    + "</tr></thead><tbody>"
                )
                continue
            out.append("<tr>" + "".join(f"<td>{_inline(c, base_dir)}</td>" for c in cells) + "</tr>")
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
            out.append(f"<h{level}>{_inline(m.group(2), base_dir)}</h{level}>")
            continue

        # --- blockquote ---
        if line.startswith(">"):
            content = re.sub(r"^>\s?", "", line).strip()
            if not in_bq:
                out.append("<blockquote>")
                in_bq = True
            if content:
                out.append(f"<p>{_inline(content, base_dir)}</p>")
            continue

        # --- unordered list ---
        m = re.match(r"^\s*[-*+]\s+(.+)", line)
        if m:
            if not in_list or list_type != "ul":
                close_list()
                out.append("<ul>")
                in_list = True
                list_type = "ul"
            out.append(f"<li>{_inline(m.group(1), base_dir)}</li>")
            continue

        # --- ordered list ---
        m = re.match(r"^\s*\d+\.\s+(.+)", line)
        if m:
            if not in_list or list_type != "ol":
                close_list()
                out.append("<ol>")
                in_list = True
                list_type = "ol"
            out.append(f"<li>{_inline(m.group(1), base_dir)}</li>")
            continue

        # --- horizontal rule ---
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", line):
            out.append("<hr>")
            continue

        # --- blank line ---
        if not stripped:
            continue

        # --- paragraph ---
        out.append(f"<p>{_inline(line, base_dir)}</p>")

    close_list(); close_bq(); close_table()
    if in_example:
        inner = markdown_to_html("\n".join(example_lines), base_dir)
        out.append('<div class="example-block"><span class="example-label">Example</span>' + inner + "</div>")
    if in_code:
        out.append("</code></pre>")
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

/* headings -- sans, two weights only (400/500) */
h1,h2,h3,h4,h5,h6{font-family:var(--sans);font-weight:500;line-height:1.3;color:var(--text);}
h2{font-size:19px;margin:1.4em 0 0.5em;break-after:avoid;}
h3{font-size:16.5px;margin:1.2em 0 0.45em;break-after:avoid;}
h4,h5,h6{font-size:15px;margin:1.1em 0 0.4em;break-after:avoid;}

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
    if meta.get("version"):
        stamp_bits.append(f'Version {esc(meta["version"])}')
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


def _relations_html(node, nodes):
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
            if tid in nodes:
                link = f'<a class="rel-link" href="#node-{esc(tid)}">{esc(label)}</a>'
            else:
                link = f'<span>{esc(label)}</span>'
            rows.append(f'<div class="rel-item">{type_badge}{link}</div>')
        out.append('<div class="relations"><h4>See also</h4>' + "".join(rows) + "</div>")

    if children:
        rows = []
        for cid in children:
            ctitle = nodes.get(cid, {}).get("title", cid)
            if cid in nodes:
                rows.append(f'<div class="rel-item"><span class="rel-bullet">&bull;</span><a class="rel-link" href="#node-{esc(cid)}">{esc(ctitle)}</a></div>')
            else:
                rows.append(f'<div class="rel-item"><span class="rel-bullet">&bull;</span><span>{esc(ctitle)}</span></div>')
        out.append('<div class="relations"><h4>In this section</h4>' + "".join(rows) + "</div>")
    return "".join(out)


def build_main_html(data, base_dir, order, page_map=None):
    """page_map: {node_id: int} for TOC page numbers, or None (placeholder pass)."""
    nodes = data.get("nodes", {})
    parts = ['<!DOCTYPE html><html><head><meta charset="utf-8"><style>', CSS, "</style></head><body>"]

    # ---- Table of contents ----
    parts.append('<section class="toc">')
    parts.append("<h1>Table of contents</h1>")
    for nid, depth in order:
        node = nodes.get(nid, {})
        title = node.get("title", nid)
        diff = node.get("difficulty")
        dot = ""
        if diff in DIFFICULTY_RAMP:
            dot = f'<span class="dot" style="background:{DIFFICULTY_RAMP[diff][1]};"></span>'
        else:
            dot = '<span class="dot" style="background:transparent;border-color:transparent;"></span>'
        pnum = ""
        if page_map is not None:
            pnum = str(page_map.get(nid, ""))
        parts.append(
            f'<div class="toc-entry depth-{depth}" style="padding-left:{depth*16}px">'
            f'{dot}<a class="toc-title" href="#node-{esc(nid)}">{esc(title)}</a>'
            f'<span class="leader"></span><span class="page">{pnum}</span></div>'
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
    parts.append("</section>")

    # ---- Chapters ----
    for nid, depth in order:
        node = nodes.get(nid, {})
        title = node.get("title", nid)
        parts.append(f'<section class="chapter depth-{depth}" id="node-{esc(nid)}">')
        parts.append(f'<span class="pagemark">{MARK_PREFIX}{esc(nid)}{MARK_PREFIX}</span>')
        parts.append(f'<h1 class="chapter-title">{esc(title)}</h1>')
        parts.append(_meta_bar(node))
        if node.get("summary"):
            parts.append(f'<p class="chapter-summary">{esc(node["summary"])}</p>')
        parts.append('<hr class="title-rule">')
        body = markdown_to_html(node.get("content", ""), base_dir)
        parts.append(f'<div class="chapter-body">{body}</div>')
        parts.append(_media_html(node, base_dir))
        parts.append(_relations_html(node, nodes))
        parts.append("</section>")

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
                    "to": l.get("to") or fitz.Point(0, 0),
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
        final.save(str(out_path))
    finally:
        main.close()
        final.close()


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def generate_pdf(json_path, output_path=None):
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

    if not isinstance(data, dict) or "nodes" not in data:
        print("Error: not a valid .entropy.json (missing 'nodes').")
        sys.exit(1)

    meta = data.get("meta", {}) or {}
    nodes = data.get("nodes", {}) or {}
    if not nodes:
        print("Error: no nodes to render.")
        sys.exit(1)

    base_dir = json_path.parent
    book_title = meta.get("title", "Untitled")
    order = tree_order(data)
    ids = [nid for nid, _ in order]

    if output_path is None:
        output_path = json_path.with_suffix(".pdf")
    else:
        output_path = Path(output_path).resolve()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is required. Install with:")
        print("  py -m pip install playwright pymupdf")
        print("  py -m playwright install chromium")
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        cover_pdf = tmp / "cover.pdf"
        main_pass1 = tmp / "main_p1.pdf"
        main_pass2 = tmp / "main_p2.pdf"

        cover_html = build_cover_html(meta)
        main_html_1 = build_main_html(data, base_dir, order, page_map=None)

        with sync_playwright() as pw:
            print("Rendering cover ...")
            _render_pdf(pw, cover_html, cover_pdf, with_footer=False, book_title=book_title)

            print("Rendering body (pass 1 of 2) ...")
            _render_pdf(pw, main_html_1, main_pass1, with_footer=True, book_title=book_title)

            page_map = _marker_pages(main_pass1, ids)
            missing = [nid for nid in ids if nid not in page_map]
            if missing:
                print(f"  Note: page number not located for {len(missing)} node(s); leaving blank.")

            print("Rendering body (pass 2 of 2) ...")
            main_html_2 = build_main_html(data, base_dir, order, page_map=page_map)
            _render_pdf(pw, main_html_2, main_pass2, with_footer=True, book_title=book_title)

        print("Merging cover + body ...")
        try:
            _merge(cover_pdf, main_pass2, output_path)
        except Exception as exc:
            # output likely locked (open in a viewer) -> write a sibling file
            alt = output_path.with_stem(output_path.stem + "_new")
            print(f"  Could not write {output_path.name} ({exc}); writing {alt.name} instead.")
            _merge(cover_pdf, main_pass2, alt)
            output_path = alt

    print(f"\nPDF generated: {output_path}")
    print(f"  Nodes: {len(order)}")
    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: py entropy_to_pdf_v2.py <input.entropy.json> [output.pdf]")
        sys.exit(1)
    in_file = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    generate_pdf(in_file, out_file)
