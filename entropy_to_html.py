#!/usr/bin/env python3
"""
entropy_to_html.py - Single-file, mobile-friendly HTML generator for .entropy.json.

Companion to entropy_to_pdf_v2.py. Where the PDF tool produces a paginated,
print-oriented document, this produces ONE self-contained .html file built for
reading on a phone:

  - continuous linear scroll (every node, depth-first, top to bottom)
  - responsive single-column layout with a comfortable reading measure
  - <meta viewport> + large, fluid type + light/dark auto theme
  - images embedded inline as base64 data URIs -> the file is fully portable
    (email it, drop it in a cloud folder, open it offline -- no external assets)
  - links (including YouTube/Vimeo) render as ordinary clickable links that open
    in the browser/app -- nothing is embedded that would need a live connection
  - ZERO JavaScript: collapsible table of contents via <details>, smooth scroll,
    and back-to-top via CSS/anchors only

It reuses the same markdown parser and image-embedding logic as the PDF tool so
the two outputs stay in parity. No third-party packages required -- standard
library only.

Usage:
    py entropy_to_html.py <input.entropy.json> [output.html]

If no output path is given, the .html is written next to the input file.
"""

import base64
import html
import json
import mimetypes
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Design-system palette (clean editorial light) -- mirrors entropy_to_pdf_v2.py
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
# Markdown -> HTML  (parity with explainer/js/markdown.js + entropy_to_pdf_v2.py)
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
    """Convert a markdown string to HTML. Mirrors the explainer / PDF parser."""
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
        # --- :::example blocks --- (buffer until :::, then parse inner as full
        # markdown; checked BEFORE code/list so nested ``` aren't swallowed)
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

        # --- headings (content headings start at h2; node title is the section h2) ---
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
        for child in nodes[nid].get("children", []) or []:
            walk(child, depth + 1)

    if root_id and root_id in nodes:
        walk(root_id, 0)
    # append any orphan nodes not reachable from root
    for nid in nodes:
        if nid not in visited:
            order.append((nid, 0))
    return order


# ---------------------------------------------------------------------------
# CSS -- screen + mobile (light/dark auto), clean editorial style
# ---------------------------------------------------------------------------
CSS = """
:root{
  --bg:#ffffff; --text:#1a1a1a; --text-2:#555555; --text-3:#888888;
  --border:#e5e5e5; --accent:#2563eb; --accent-light:#eff6ff;
  --code-bg:#f4f4f5; --pre-bg:#f7f7f8;
  --sans:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Palatino Linotype","Times New Roman",serif;
  --mono:"Consolas","SFMono-Regular","Liberation Mono",Menlo,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#16181c; --text:#e7e7e7; --text-2:#b2b2b2; --text-3:#8a8a8a;
    --border:#2c2f36; --accent:#6ea8fe; --accent-light:#1b2433;
    --code-bg:#22252b; --pre-bg:#1b1e23;
  }
}
*{box-sizing:border-box;}
/* Anchor rem to the body reading size so the whole type scale stays coherent.
   (rem is relative to <html>; leaving it at the 16px default made sub-headings
   smaller than body text.) Mobile shrinks this one value to scale everything. */
html{font-size:18px; scroll-behavior:smooth;}
body{
  margin:0; background:var(--bg); color:var(--text);
  font-family:var(--serif); font-size:1rem; line-height:1.7; font-weight:400;
  -webkit-text-size-adjust:100%;
}
.doc{max-width:720px; margin:0 auto; padding:40px 22px 96px;}
p{margin:0 0 0.9em;}
a{color:var(--accent); text-decoration:none;}
a:hover{text-decoration:underline;}

/* ---- book header ---- */
.book-header{margin:0;}
.book-title{font-family:var(--sans); font-weight:600; font-size:2.3rem; line-height:1.15; margin:0; color:var(--text);}
.subtitle{font-style:italic; font-size:1.25rem; color:var(--text-2); margin:.5em 0 0;}
.byline{font-family:var(--sans); font-size:.8rem; color:var(--text-3); margin:.9em 0 0;}
.book-desc{font-size:1rem; color:var(--text-2); margin:1em 0 0; line-height:1.6;}
.header-rule{border:none; border-top:2px solid var(--accent); width:56px; margin:24px 0 8px;}

/* ---- table of contents (collapsible, no JS) ---- */
.toc{margin:22px 0 8px; border:0.5px solid var(--border); border-radius:10px; background:var(--pre-bg);}
.toc>summary{
  font-family:var(--sans); font-weight:500; font-size:.95rem; cursor:pointer;
  padding:12px 16px; list-style:none; color:var(--text);
}
.toc>summary::-webkit-details-marker{display:none;}
.toc>summary::before{content:"\\2630  "; color:var(--accent);}
.toc ul{list-style:none; margin:0; padding:0 16px 14px;}
.toc li{font-family:var(--sans); font-size:.9rem; margin:5px 0; line-height:1.4;}
.toc li a{color:var(--accent);}
.toc .d1{padding-left:16px;} .toc .d2{padding-left:32px;}
.toc .d3{padding-left:48px;} .toc .d4{padding-left:64px;} .toc .d5{padding-left:80px;}

/* ---- sections ---- */
.node{scroll-margin-top:16px; padding-top:30px; margin-top:30px; border-top:0.5px solid var(--border);}
.node:first-of-type{border-top:none; margin-top:10px; padding-top:10px;}
.node-title{font-family:var(--sans); font-weight:600; font-size:1.8rem; line-height:1.2; margin:0 0 6px; color:var(--text);}
.node.depth-1 .node-title{font-size:1.55rem;}
.node.depth-2 .node-title{font-size:1.35rem;}
.node.depth-3 .node-title,.node.depth-4 .node-title,.node.depth-5 .node-title{font-size:1.18rem;}
.node-summary{font-style:italic; font-size:1.05rem; color:var(--text-2); margin:6px 0 0; line-height:1.55;}
.title-rule{border:none; border-top:2px solid var(--accent); width:48px; margin:14px 0 16px;}

/* ---- meta bar ---- */
.meta-bar{display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0 0 4px;}
.badge{display:inline-block; font-family:var(--sans); font-size:.7rem; font-weight:500; padding:2px 9px; border-radius:11px; border:0.5px solid; line-height:1.6;}
.meta-time,.meta-tag{font-family:var(--sans); font-size:.72rem; color:var(--text-3);}
.meta-tag::before{content:"#"; opacity:.5;}

/* ---- content typography ---- */
.node-body h2{font-family:var(--sans); font-weight:600; font-size:1.3rem; line-height:1.3; margin:1.4em 0 .5em;}
.node-body h3{font-family:var(--sans); font-weight:600; font-size:1.12rem; line-height:1.3; margin:1.2em 0 .45em;}
.node-body h4,.node-body h5,.node-body h6{font-family:var(--sans); font-weight:600; font-size:1rem; margin:1.1em 0 .4em; color:var(--text-2);}
strong{font-weight:600;} em{font-style:italic;} del{color:var(--text-3);}
code{font-family:var(--mono); font-size:.85em; background:var(--code-bg); padding:1px 5px; border-radius:4px;}
pre{background:var(--pre-bg); border:0.5px solid var(--border); border-radius:8px; padding:14px 16px; overflow:auto; margin:0 0 1em;}
pre code{background:none; padding:0; font-size:.82rem; line-height:1.5;}
blockquote{margin:1em 0; padding:.2em 0 .2em 16px; border-left:3px solid var(--accent); color:var(--text-2); font-style:italic;}
blockquote p{margin:0 0 .4em;}
ul,ol{margin:0 0 .9em; padding-left:1.5em;}
li{margin:.25em 0;}
hr{border:none; border-top:0.5px solid var(--border); margin:1.6em 0;}
table{width:100%; border-collapse:collapse; margin:1em 0; font-size:.9rem; display:block; overflow-x:auto;}
th,td{border:0.5px solid var(--border); padding:7px 11px; text-align:left; vertical-align:top;}
thead th{background:var(--pre-bg); font-family:var(--sans); font-weight:600;}

/* ---- media / images ---- */
img{display:block; max-width:100%; height:auto; margin:.6em auto; border-radius:8px;}
figure{margin:1.3em 0; text-align:center;}
figcaption{font-family:var(--sans); font-size:.78rem; font-style:italic; color:var(--text-3); margin-top:6px;}
.media-error{font-family:var(--sans); font-size:.8rem; color:#c0392b;}
.media-link{display:block; font-family:var(--sans); font-size:.85rem; color:var(--text-2); border:0.5px solid var(--border); border-radius:8px; padding:10px 12px; margin:1em 0;}
.media-link .mtype{color:var(--accent); font-weight:500; margin-right:6px;}

/* ---- :::example blocks ---- */
.example-block{background:var(--accent-light); border-left:3px solid var(--accent); padding:10px 16px; margin:1em 0; border-radius:0 8px 8px 0;}
.example-block .example-label{display:block; font-family:var(--sans); font-size:.7rem; font-weight:600; color:var(--accent); margin-bottom:4px;}
.example-block p:last-child{margin-bottom:0;}

/* ---- relations: See also / In this section ---- */
.relations{margin-top:22px; padding-top:14px; border-top:0.5px solid var(--border);}
.relations h4{font-family:var(--sans); font-size:.78rem; font-weight:600; color:var(--text-2); margin:0 0 8px;}
.relations + .relations{margin-top:14px; border-top:none; padding-top:0;}
.rel-item{display:flex; align-items:baseline; gap:8px; margin:5px 0; font-family:var(--sans); font-size:.88rem;}
.rel-type{flex:none; font-size:.65rem; font-weight:500; padding:1px 7px; border-radius:9px; border:0.5px solid; line-height:1.6;}
.rel-link{color:var(--accent);}
.rel-bullet{color:var(--text-3); flex:none;}

/* ---- footer + back-to-top ---- */
.book-footer{margin-top:48px; padding-top:16px; border-top:0.5px solid var(--border); font-family:var(--sans); font-size:.75rem; color:var(--text-3); text-align:center; line-height:1.6;}
.to-top{position:fixed; right:16px; bottom:16px; font-family:var(--sans); font-size:.8rem; background:var(--accent); color:#fff; padding:8px 13px; border-radius:20px; text-decoration:none; opacity:.85; box-shadow:0 2px 8px rgba(0,0,0,.2);}
.to-top:hover{opacity:1; text-decoration:none;}

/* On phones, shrink the single root size -> the entire rem scale shrinks
   proportionally, keeping the heading/body hierarchy intact. */
@media (max-width:480px){
  html{font-size:16.5px;}
  .doc{padding:28px 16px 88px;}
}
"""


# ---------------------------------------------------------------------------
# HTML builders
# ---------------------------------------------------------------------------
def _badge_style(ramp):
    fill, stroke, text = ramp
    return f"background:{fill};border-color:{stroke};color:{text};"


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


def build_html(data, base_dir, order, source_name):
    """Build the complete standalone HTML document as a string."""
    meta = data.get("meta", {}) or {}
    nodes = data.get("nodes", {}) or {}
    title = esc(meta.get("title", "Untitled"))

    parts = [
        "<!DOCTYPE html>",
        '<html lang="en">',
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        f"<title>{title}</title>",
        "<style>" + CSS + "</style>",
        "</head>",
        "<body>",
        '<main class="doc" id="top">',
    ]

    # ---- book header ----
    parts.append('<header class="book-header">')
    parts.append(f'<h1 class="book-title">{title}</h1>')
    if meta.get("subtitle"):
        parts.append(f'<p class="subtitle">{esc(meta["subtitle"])}</p>')
    stamp = []
    if meta.get("author"):
        stamp.append(esc(meta["author"]))
    if meta.get("version"):
        stamp.append("v" + esc(meta["version"]))
    if meta.get("modified"):
        stamp.append(esc(str(meta["modified"])[:10]))
    if stamp:
        parts.append(f'<p class="byline">{"  &middot;  ".join(stamp)}</p>')
    if meta.get("description"):
        parts.append(f'<p class="book-desc">{esc(meta["description"])}</p>')
    parts.append('<hr class="header-rule">')
    parts.append("</header>")

    # ---- table of contents (only worth showing for multi-node books) ----
    if len(order) > 1:
        parts.append('<details class="toc" open>')
        parts.append("<summary>Contents</summary>")
        parts.append("<ul>")
        for nid, depth in order:
            t = esc(nodes.get(nid, {}).get("title", nid))
            d = min(depth, 5)
            parts.append(f'<li class="d{d}"><a href="#node-{esc(nid)}">{t}</a></li>')
        parts.append("</ul>")
        parts.append("</details>")

    # ---- sections (continuous linear scroll) ----
    parts.append("<article>")
    for nid, depth in order:
        node = nodes.get(nid, {})
        t = esc(node.get("title", nid))
        d = min(depth, 5)
        parts.append(f'<section class="node depth-{d}" id="node-{esc(nid)}">')
        parts.append(f'<h2 class="node-title">{t}</h2>')
        parts.append(_meta_bar(node))
        if node.get("summary"):
            parts.append(f'<p class="node-summary">{esc(node["summary"])}</p>')
        parts.append('<hr class="title-rule">')
        body = markdown_to_html(node.get("content", ""), base_dir)
        parts.append(f'<div class="node-body">{body}</div>')
        parts.append(_media_html(node, base_dir))
        parts.append(_relations_html(node, nodes))
        parts.append("</section>")
    parts.append("</article>")

    # ---- footer ----
    n = len(order)
    foot_bits = [esc(meta.get("title", "")), f"{n} section" + ("" if n == 1 else "s"),
                 f"generated from {esc(source_name)}"]
    parts.append('<footer class="book-footer">' + "  &middot;  ".join(b for b in foot_bits if b) + "</footer>")

    parts.append("</main>")
    if len(order) > 1:
        parts.append('<a class="to-top" href="#top" aria-label="Back to top">&uarr; Top</a>')
    parts.append("</body>")
    parts.append("</html>")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def generate_html(json_path, output_path=None):
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

    nodes = data.get("nodes", {}) or {}
    if not isinstance(nodes, dict) or not nodes:
        print("Error: no nodes to render.")
        sys.exit(1)

    base_dir = json_path.parent
    order = tree_order(data)
    if not order:
        print("Error: no reachable nodes to render.")
        sys.exit(1)

    html_str = build_html(data, base_dir, order, json_path.name)

    if output_path is None:
        output_path = json_path.with_suffix(".html")
    else:
        output_path = Path(output_path).resolve()

    try:
        output_path.write_text(html_str, encoding="utf-8")
    except OSError as exc:
        # output likely locked (open in a viewer) -> write a sibling file
        alt = output_path.with_stem(output_path.stem + "_new")
        print(f"  Could not write {output_path.name} ({exc}); writing {alt.name} instead.")
        alt.write_text(html_str, encoding="utf-8")
        output_path = alt

    size_kb = output_path.stat().st_size / 1024
    print(f"\nHTML generated: {output_path}")
    print(f"  Sections: {len(order)}")
    print(f"  File size: {size_kb:.0f} KB (CSS + images embedded; fully self-contained)")
    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: py entropy_to_html.py <input.entropy.json> [output.html]")
        sys.exit(1)
    in_file = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    generate_html(in_file, out_file)
