#!/usr/bin/env python3
"""
entropy_to_epub.py - EPUB 3 generator for .entropy.json book files.

Third exporter in the pipeline, alongside entropy_to_html.py (single-file
mobile HTML) and entropy_to_pdf_v2.py (paginated print PDF). It reuses the
markdown parser and section builders from entropy_to_html.py so all three
outputs stay in parity, then packages the result as a standards-compliant
EPUB 3 container:

  - `mimetype` first in the zip, STORED (uncompressed), per the OCF spec
  - META-INF/container.xml -> OEBPS/content.opf (package doc + manifest + spine)
  - OEBPS/nav.xhtml (EPUB 3 nav doc) AND OEBPS/toc.ncx (legacy readers)
  - one XHTML content document per book item (title page, frontmatter,
    part dividers, numbered chapters, epilogues, back-matter index)
  - data-URI images extracted to OEBPS/images/, deduplicated by SHA-1
  - e-reader-safe CSS (no CSS variables, no fixed positioning, no viewport
    units) adapted from the HTML exporter's light editorial palette
  - stable identifier (urn:uuid derived from a hash of title+author) so
    rebuilding the same book produces the same identifier

WATERMARK CONTRACT (do not break): every content .xhtml under OEBPS/text/
must contain the literal string "</body>" exactly once -- no attributes or
whitespace variations. A downstream tool injects a per-reader watermark by
string-replacing "</body>". The build verifies this before zipping.

No third-party packages required -- standard library only.

Usage:
    py entropy_to_epub.py <input.entropy.json> [output.epub]

If no output path is given, the .epub is written next to the input file.
Importable API:  build_epub(json_path, output_path=None) -> Path
"""

import base64
import binascii
import hashlib
import html.entities
import io
from html.parser import HTMLParser
import json
import mimetypes
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# Make the sibling module importable regardless of the caller's cwd.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from entropy_to_html import (  # noqa: E402  (path setup must precede import)
    markdown_to_html,
    structured_items,
    tree_order,
    esc,
    roman,
    sentence_case,
    _meta_bar,
    _media_html,
    _relations_html,
)


# ---------------------------------------------------------------------------
# E-reader-safe CSS -- literal colors from the entropy_to_html light palette
# (no :root variables, no position:fixed, no vw/vh units, no flexbox)
# ---------------------------------------------------------------------------
EPUB_CSS = """\
/* Adapted from entropy_to_html.py light palette:
   bg #ffffff  text #1a1a1a  text-2 #555555  text-3 #888888
   border #e5e5e5  accent #2563eb  accent-light #eff6ff
   code-bg #f4f4f5  pre-bg #f7f7f8 */
body{font-family:Georgia,"Palatino Linotype","Times New Roman",serif;
  color:#1a1a1a; line-height:1.6; margin:0 4%;}
p{margin:0 0 0.9em;}
a{color:#2563eb; text-decoration:none;}
h1,h2,h3,h4,h5,h6{font-family:"Helvetica Neue",Arial,sans-serif; color:#1a1a1a;}

/* ---- title page ---- */
.book-title{font-weight:bold; font-size:2em; line-height:1.15; margin:2em 0 0;}
.subtitle{font-family:Georgia,serif; font-style:italic; font-size:1.2em;
  color:#555555; margin:0.6em 0 0; font-weight:normal;}
.byline{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.85em;
  color:#888888; margin:1.2em 0 0;}
.book-desc{font-size:0.95em; color:#555555; margin:1.2em 0 0; line-height:1.55;}
.header-rule{border:none; border-top:2px solid #2563eb; width:25%; margin:1.6em 0 0;}

/* ---- part dividers ---- */
.part-divider{margin:30% 0 0; padding:1.4em 0 1.2em;
  border-top:2px solid #2563eb; border-bottom:1px solid #e5e5e5;}
.part-eyebrow{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.8em;
  font-weight:bold; letter-spacing:0.2em; text-transform:uppercase;
  color:#2563eb; margin:0 0 0.5em;}
.part-title{font-weight:bold; font-size:1.8em; line-height:1.15; margin:0;}

/* ---- chapters ---- */
.chapter-num{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.75em;
  font-weight:bold; letter-spacing:0.16em; text-transform:uppercase;
  color:#2563eb; margin:1.5em 0 0.3em;}
.chapter-num.chapter-ep{color:#888888;}
.node-title{font-weight:bold; font-size:1.6em; line-height:1.2; margin:0 0 0.3em;}
.node-summary{font-style:italic; font-size:1.02em; color:#555555;
  margin:0.4em 0 0; line-height:1.5;}
.title-rule{border:none; border-top:2px solid #2563eb; width:18%;
  margin:0.9em 0 1em; text-align:left;}

/* ---- meta bar / badges ---- */
.meta-bar{margin:0 0 0.4em;}
.badge{display:inline-block; font-family:"Helvetica Neue",Arial,sans-serif;
  font-size:0.7em; font-weight:bold; padding:1px 8px; border:1px solid;
  border-radius:10px; margin-right:6px;}
.meta-time,.meta-tag{font-family:"Helvetica Neue",Arial,sans-serif;
  font-size:0.72em; color:#888888; margin-right:8px;}

/* ---- content typography ---- */
.node-body h2{font-size:1.25em; margin:1.3em 0 0.5em;}
.node-body h3{font-size:1.1em; margin:1.2em 0 0.45em;}
.node-body h4,.node-body h5,.node-body h6{font-size:0.95em;
  letter-spacing:0.08em; text-transform:uppercase; color:#2563eb;
  margin:1.4em 0 0.5em;}
strong{font-weight:bold;} em{font-style:italic;} del{color:#888888;}
code{font-family:"Courier New",Courier,monospace; font-size:0.85em;
  background-color:#f4f4f5; padding:0 4px; border-radius:3px;}
pre{background-color:#f7f7f8; border:1px solid #e5e5e5; border-radius:6px;
  padding:0.8em 1em; overflow:auto; margin:0 0 1em; font-size:0.82em;
  line-height:1.45; white-space:pre-wrap;}
pre code{background-color:transparent; padding:0;}
blockquote{margin:1em 0; padding:0.2em 0 0.2em 1em;
  border-left:3px solid #2563eb; color:#555555; font-style:italic;}
blockquote p{margin:0 0 0.4em;}
ul,ol{margin:0 0 0.9em; padding-left:1.5em;}
li{margin:0.25em 0;}
hr{border:none; border-top:1px solid #e5e5e5; margin:1.5em 0;}
table{width:100%; border-collapse:collapse; margin:1em 0; font-size:0.88em;}
th,td{border:1px solid #e5e5e5; padding:5px 9px; text-align:left;
  vertical-align:top;}
thead th{background-color:#f7f7f8; font-family:"Helvetica Neue",Arial,sans-serif;}

/* ---- media / images ---- */
img{max-width:100%; margin:0.6em 0;}
figure{margin:1.2em 0; text-align:center;}
figcaption{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.78em;
  font-style:italic; color:#888888; margin-top:5px;}
.media-error{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.8em;
  color:#c0392b;}
.media-link{display:block; font-family:"Helvetica Neue",Arial,sans-serif;
  font-size:0.85em; color:#555555; border:1px solid #e5e5e5; border-radius:6px;
  padding:0.6em 0.8em; margin:1em 0;}
.media-link .mtype{color:#2563eb; font-weight:bold; margin-right:6px;}

/* ---- :::example blocks ---- */
.example-block{background-color:#eff6ff; border-left:3px solid #2563eb;
  padding:0.6em 1em; margin:1em 0;}
.example-block .example-label{display:block;
  font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.7em;
  font-weight:bold; color:#2563eb; margin-bottom:0.3em;}
.example-block p{margin-bottom:0.5em;}

/* ---- relations: See also / In this section ---- */
.relations{margin-top:1.4em; padding-top:0.9em; border-top:1px solid #e5e5e5;}
.relations h4{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.78em;
  font-weight:bold; color:#555555; margin:0 0 0.5em; text-transform:none;
  letter-spacing:normal;}
.rel-item{margin:0.35em 0; font-family:"Helvetica Neue",Arial,sans-serif;
  font-size:0.88em;}
.rel-type{display:inline-block; font-size:0.7em; font-weight:bold;
  padding:0 6px; border:1px solid; border-radius:8px; margin-right:7px;}
.rel-link{color:#2563eb;}
.rel-bullet{color:#888888; margin-right:6px;}

/* ---- back-matter index ---- */
.backmatter-index .node-title{font-size:1.5em;}
.index-list{font-family:"Helvetica Neue",Arial,sans-serif; font-size:0.85em;
  line-height:1.5; margin-top:0.7em;}
.idx-entry{margin:0.3em 0; color:#555555;}
.idx-term{color:#1a1a1a; font-weight:bold;}
.idx-ch{color:#2563eb;} .idx-ch-main{color:#2563eb; font-weight:bold;}
.idx-see{font-style:italic; color:#888888;}
"""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _slug(value, fallback="item"):
    """Filesystem/URL-safe slug from a node id or title."""
    if value is None:
        return fallback
    s = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(value)).strip("-").lower()
    return s or fallback


def _stable_identifier(meta):
    """urn:uuid derived from SHA-1 of title+author -> identical on rebuilds."""
    if not isinstance(meta, dict):
        meta = {}
    seed = f"{meta.get('title', '')}|{meta.get('author', '')}"
    h = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    return f"urn:uuid:{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"


def _modified_stamp(meta):
    """meta.modified -> CCYY-MM-DDThh:mm:ssZ (required dcterms:modified form).

    Deterministic: never falls back to datetime.now(). If neither modified nor
    created parses, a fixed epoch-ish constant is used so rebuilds are stable.
    """
    if not isinstance(meta, dict):
        meta = {}
    for key in ("modified", "created"):
        raw = str(meta.get(key) or "")
        m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})", raw)
        if m:
            return f"{m.group(1)}T{m.group(2)}Z"
        m = re.match(r"^(\d{4}-\d{2}-\d{2})$", raw)
        if m:
            return f"{m.group(1)}T00:00:00Z"
    return "2000-01-01T00:00:00Z"


# ---------------------------------------------------------------------------
# XHTML well-formedness: void elements + named-entity conversion
# ---------------------------------------------------------------------------
# Entities that are predefined in XML and may remain named.
_XML_SAFE_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}

# Entity-reference / numeric-reference shapes that are already legal.
_LEGAL_REF = r"(?:[a-zA-Z][a-zA-Z0-9]*|#[0-9]+|#x[0-9a-fA-F]+);"


def _convert_entities(html_str):
    """Convert named HTML entities (except XML-safe ones) to numeric refs.

    The HTML builders emit things like &middot; &bull; &mdash; &uarr; which
    are undefined in XML and would break ET parsing. Unknown names get their
    ampersand escaped; stray bare ampersands are escaped too.
    """
    if not isinstance(html_str, str):
        raise TypeError(f"_convert_entities expects str, got {type(html_str)}")

    def _named(m):
        name = m.group(1)
        if name in _XML_SAFE_ENTITIES:
            return m.group(0)
        ch = html.entities.html5.get(name + ";")
        if ch is None:
            return "&amp;" + name + ";"  # unknown entity -> visible literal
        return "".join(f"&#{ord(c)};" for c in ch)

    out = re.sub(r"&([a-zA-Z][a-zA-Z0-9]*);", _named, html_str)
    # any remaining bare '&' not starting a legal reference
    out = re.sub(r"&(?!" + _LEGAL_REF + r")", "&amp;", out)
    return out


_VOID_TAGS = {"img", "hr", "br", "meta", "link", "input", "area", "base",
              "col", "embed", "source", "track", "wbr"}


class _XHTMLRebuilder(HTMLParser):
    """Re-serialize an HTML fragment as well-formed XHTML.

    Why a parser instead of pure regex: the markdown emphasis regexes can
    emit overlapping inline tags (e.g. <strong><em></em></em></strong>) when
    the source markdown has unbalanced asterisk runs. Browsers tolerate that;
    XML does not. Rebuilding through a tag stack guarantees well-formedness:
      - void elements are self-closed
      - stray close tags are dropped
      - unclosed tags are closed (at the point their ancestor closes, or EOF)
      - named entities become literal UTF-8 characters, text/attributes are
        re-escaped with only the XML-safe named entities
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []
        self.stack = []

    def _attrs(self, attrs):
        return "".join(f' {k}="{esc("" if v is None else v)}"' for k, v in attrs)

    def handle_starttag(self, tag, attrs):
        if tag in _VOID_TAGS:
            self.out.append(f"<{tag}{self._attrs(attrs)} />")
        else:
            self.out.append(f"<{tag}{self._attrs(attrs)}>")
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.out.append(f"<{tag}{self._attrs(attrs)} />")

    def handle_endtag(self, tag):
        if tag in _VOID_TAGS:
            return
        if tag in self.stack:
            while self.stack:
                top = self.stack.pop()
                self.out.append(f"</{top}>")
                if top == tag:
                    break
        # else: stray close tag with no matching open -> drop it

    def handle_data(self, data):
        self.out.append(esc(data))

    def result(self):
        while self.stack:  # close anything left open at end of fragment
            self.out.append(f"</{self.stack.pop()}>")
        return "".join(self.out)


def sanitize_xhtml(html_str):
    """Full HTML -> XHTML fragment cleanup used on every content body."""
    if not isinstance(html_str, str):
        raise TypeError(f"sanitize_xhtml expects str, got {type(html_str)}")
    builder = _XHTMLRebuilder()
    try:
        builder.feed(html_str)
        builder.close()
    except Exception as exc:  # parser failure must be loud, not silent
        raise ValueError(f"could not sanitize HTML fragment: {exc}") from exc
    # defensive second pass: normally a no-op after the rebuild
    return _convert_entities(builder.result())


# ---------------------------------------------------------------------------
# Image extraction: data: URIs -> OEBPS/images/img-<hash8>.<ext>, deduped
# ---------------------------------------------------------------------------
_MIME_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
}

_IMG_FAIL = '<span class="media-error">[image could not be embedded]</span>'


def _decode_data_uri(src):
    """data: URI -> (mime, bytes) or (None, None) on any validation failure."""
    if not isinstance(src, str) or not src.startswith("data:"):
        return None, None
    m = re.match(r"^data:([^;,]+)(;base64)?,(.*)$", src, re.S)
    if not m:
        return None, None
    mime, is_b64, payload = m.group(1).strip().lower(), m.group(2), m.group(3)
    if not mime.startswith("image/") or not is_b64 or not payload:
        return None, None
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError):
        return None, None
    if not raw:
        return None, None
    return mime, raw


def _process_images(html_str, registry, stats):
    """Replace <img src="data:..."> with file refs; register image bytes.

    registry: dict sha1_hex -> {"name", "mime", "data"}  (shared across book)
    stats:    dict with "img_found" / "img_failed" counters (mutated)
    Non-data (remote/unresolved) image srcs are replaced with a visible span:
    EPUB content must not depend on network resources.
    """
    if not isinstance(html_str, str):
        raise TypeError(f"_process_images expects str, got {type(html_str)}")
    if not isinstance(registry, dict) or not isinstance(stats, dict):
        raise TypeError("_process_images: registry and stats must be dicts")

    def _img(m):
        tag = m.group(0)
        stats["img_found"] = stats.get("img_found", 0) + 1
        srcm = re.search(r'src="([^"]*)"', tag)
        if not srcm:
            stats["img_failed"] = stats.get("img_failed", 0) + 1
            return _IMG_FAIL
        mime, raw = _decode_data_uri(srcm.group(1))
        if raw is None:
            stats["img_failed"] = stats.get("img_failed", 0) + 1
            return _IMG_FAIL
        digest = hashlib.sha1(raw).hexdigest()
        if digest not in registry:
            ext = _MIME_EXT.get(mime) or mimetypes.guess_extension(mime) or ".bin"
            registry[digest] = {
                "name": f"img-{digest[:8]}{ext}",
                "mime": mime,
                "data": raw,
            }
        name = registry[digest]["name"]
        new_tag = re.sub(r'src="[^"]*"', f'src="../images/{name}"', tag, count=1)
        if "alt=" not in new_tag:
            new_tag = new_tag[:-1].rstrip("/").rstrip() + ' alt="" >'
        return new_tag

    return re.sub(r"<img\b[^>]*>", _img, html_str)


# ---------------------------------------------------------------------------
# Internal links: #node-<id> -> <chapter file>.xhtml#node-<id>
# ---------------------------------------------------------------------------
def _rewrite_node_links(html_str, nid_to_file):
    """Rewrite intra-book anchors to cross-file hrefs; de-link unknown ids."""
    if not isinstance(html_str, str):
        raise TypeError(f"_rewrite_node_links expects str, got {type(html_str)}")
    if not isinstance(nid_to_file, dict):
        raise TypeError("_rewrite_node_links: nid_to_file must be a dict")

    def _a(m):
        nid = m.group(2)
        fname = nid_to_file.get(nid)
        if fname is None:
            return f"<span>{m.group(4)}</span>"  # plain text, no dead link
        return (f'<a{m.group(1)}href="{fname}#node-{nid}"'
                f"{m.group(3)}>{m.group(4)}</a>")

    return re.sub(
        r'<a\b([^>]*?)href="#node-([^"]+)"([^>]*)>(.*?)</a>',
        _a, html_str, flags=re.S,
    )


# ---------------------------------------------------------------------------
# XHTML document wrapper (carries the watermark contract: one literal </body>)
# ---------------------------------------------------------------------------
def _xhtml_doc(title, body_html, css_href="../css/style.css", epub_ns=False):
    """Wrap a sanitized body fragment in a complete XHTML5 document."""
    if not isinstance(body_html, str):
        raise TypeError(f"_xhtml_doc expects str body, got {type(body_html)}")
    if "</body>" in body_html:
        raise ValueError("body fragment must not contain a literal </body> "
                         "(watermark contract requires exactly one)")
    ns = ' xmlns:epub="http://www.idpf.org/2007/ops"' if epub_ns else ""
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<!DOCTYPE html>\n"
        f'<html xmlns="http://www.w3.org/1999/xhtml"{ns} lang="en" xml:lang="en">\n'
        "<head>\n"
        f"<title>{esc(title)}</title>\n"
        f'<link rel="stylesheet" type="text/css" href="{esc(css_href)}" />\n'
        "</head>\n"
        "<body>\n"
        f"{body_html}\n"
        "</body>\n"
        "</html>\n"
    )


def _assert_parses(name, doc):
    """Parse one generated XML/XHTML document; raise with the file name if bad."""
    if not isinstance(doc, str) or not doc.strip():
        raise ValueError(f"{name}: empty document")
    try:
        ET.fromstring(doc)
    except ET.ParseError as exc:
        raise ValueError(f"XHTML well-formedness failure in {name}: {exc}") from exc


# ---------------------------------------------------------------------------
# Page builders (each returns a sanitized, validated full XHTML document)
# ---------------------------------------------------------------------------
def _titlepage_doc(meta):
    """Title page: title, subtitle, author, description, version/date."""
    if not isinstance(meta, dict):
        meta = {}
    out = ['<section class="titlepage" id="titlepage">']
    out.append(f'<h1 class="book-title">{esc(meta.get("title", "Untitled"))}</h1>')
    if meta.get("subtitle"):
        out.append(f'<h2 class="subtitle">{esc(meta["subtitle"])}</h2>')
    stamp = []
    if meta.get("author"):
        stamp.append(esc(meta["author"]))
    if meta.get("version"):
        stamp.append("v" + esc(meta["version"]))
    if meta.get("modified"):
        stamp.append(esc(str(meta["modified"])[:10]))
    if stamp:
        out.append(f'<p class="byline">{" &#183; ".join(stamp)}</p>')
    if meta.get("description"):
        out.append(f'<p class="book-desc">{esc(meta["description"])}</p>')
    out.append('<hr class="header-rule" />')
    out.append("</section>")
    body = sanitize_xhtml("".join(out))
    return _xhtml_doc(meta.get("title", "Untitled"), body)


def _part_doc(num, title):
    """Part divider page (Part I / II / ... + part title)."""
    body = (
        f'<section class="part-divider" id="part-{int(num)}">'
        f'<p class="part-eyebrow">Part {esc(roman(num))}</p>'
        f'<h1 class="part-title">{esc(title or "")}</h1>'
        "</section>"
    )
    return _xhtml_doc(f"Part {roman(num)}: {title or ''}", sanitize_xhtml(body))


def _node_doc(node, nid, nodes, base_dir, eyebrow_html, registry, stats,
              nid_to_file):
    """One content chapter/frontmatter/epilogue document for a node."""
    if not isinstance(node, dict):
        node = {}
    if not isinstance(nodes, dict):
        raise TypeError("_node_doc: nodes must be a dict")
    out = [f'<section class="node" id="node-{esc(str(nid))}">']
    if eyebrow_html:
        out.append(eyebrow_html)
    out.append(f'<h1 class="node-title">{esc(node.get("title", nid))}</h1>')
    out.append(_meta_bar(node))
    if node.get("summary"):
        out.append(f'<p class="node-summary">{esc(node["summary"])}</p>')
    out.append('<hr class="title-rule" />')
    body_html = markdown_to_html(node.get("content", ""), base_dir)
    out.append(f'<div class="node-body">{body_html}</div>')
    out.append(_media_html(node, base_dir))
    out.append(_relations_html(node, nodes))
    out.append("</section>")
    raw = "".join(out)
    raw = _process_images(raw, registry, stats)
    raw = _rewrite_node_links(raw, nid_to_file)
    return _xhtml_doc(node.get("title", str(nid)), sanitize_xhtml(raw))


def _index_doc(data, nid_to_file):
    """Back-matter index page from meta.index. Page numbers are dropped for
    EPUB (no fixed pagination) -- chapter references only. Returns None when
    there is no index. Mirrors the logic shape of entropy_to_html._index_html
    but emits cross-file links."""
    if not isinstance(data, dict) or not isinstance(nid_to_file, dict):
        raise TypeError("_index_doc: data and nid_to_file must be dicts")
    idx = (data.get("meta", {}) or {}).get("index")
    if not idx or not idx.get("entries"):
        return None
    num_to_nid = {}
    for it in (structured_items(data) or []):
        if it.get("kind") == "chapter":
            num_to_nid[it["num"]] = it["nid"]
    out = ['<section class="node backmatter-index" id="book-index">',
           '<h1 class="node-title">Index</h1>', '<hr class="title-rule" />',
           '<div class="index-list">']
    for e in idx["entries"]:
        if not isinstance(e, dict) or not e.get("term"):
            continue
        pnid = e.get("primary_nid")
        if pnid and pnid in nid_to_file:
            term = f'<a class="idx-term" href="#node-{esc(pnid)}">{esc(e["term"])}</a>'
        else:
            term = f'<span class="idx-term">{esc(e["term"])}</span>'
        if e.get("passim"):
            locs = '<span class="idx-see">throughout</span>'
        else:
            refs = []
            for n in e.get("chapters", []) or []:
                nid = num_to_nid.get(n)
                cls = "idx-ch-main" if n == e.get("primary_ch") else "idx-ch"
                if nid and nid in nid_to_file:
                    refs.append(f'<a class="{cls}" href="#node-{esc(nid)}">Ch {n}</a>')
                else:
                    refs.append(f'<span class="{cls}">Ch {n}</span>')
            locs = " ".join(refs)
        see = f' <span class="idx-see">&#8212; {esc(e["see"])}</span>' if e.get("see") else ""
        out.append(f'<div class="idx-entry">{term} {locs}{see}</div>')
    out.append("</div></section>")
    raw = _rewrite_node_links("".join(out), nid_to_file)
    return _xhtml_doc("Index", sanitize_xhtml(raw))


# ---------------------------------------------------------------------------
# Navigation documents: nav.xhtml (EPUB 3) + toc.ncx (legacy)
# ---------------------------------------------------------------------------
def _nav_entries(items, nodes, nid_to_file, has_index):
    """Flat [(label, href)] list in reading order; parts get nested handling
    in the nav builder but the NCX consumes this flat list."""
    if not isinstance(items, list) or not isinstance(nodes, dict):
        raise TypeError("_nav_entries: bad arguments")
    entries = [("Title Page", "text/titlepage.xhtml")]
    for it in items:
        if it["kind"] == "part":
            entries.append((f'Part {roman(it["num"])}: {it["title"]}',
                            "text/" + it["file"]))
            continue
        nid = it.get("nid")
        label = nodes.get(nid, {}).get("title", str(nid))
        if it["kind"] == "chapter":
            label = f'{it["num"]}. {label}'
        elif it["kind"] == "epilogue":
            label = f"Epilogue: {label}"
        entries.append((label, "text/" + it["file"]))
    if has_index:
        entries.append(("Index", "text/index.xhtml"))
    return entries


def _nav_doc(items, nodes, has_index, book_title):
    """EPUB 3 navigation document (nested ol: parts contain their chapters)."""
    if not isinstance(items, list) or not isinstance(nodes, dict):
        raise TypeError("_nav_doc: bad arguments")
    li = []
    li.append('<li><a href="text/titlepage.xhtml">Title Page</a></li>')
    open_part = False
    for it in items:
        if it["kind"] == "part":
            if open_part:
                li.append("</ol></li>")
            li.append(f'<li><a href="text/{it["file"]}">'
                      f'Part {esc(roman(it["num"]))}: {esc(it["title"])}</a><ol>')
            open_part = True
            continue
        nid = it.get("nid")
        label = nodes.get(nid, {}).get("title", str(nid))
        if it["kind"] == "chapter":
            label = f'{it["num"]}. {label}'
        elif it["kind"] == "epilogue":
            label = f"Epilogue: {label}"
            if open_part:
                li.append("</ol></li>")
                open_part = False
        elif it["kind"] in ("front", "node") and open_part:
            li.append("</ol></li>")
            open_part = False
        li.append(f'<li><a href="text/{it["file"]}">{esc(label)}</a></li>')
    if open_part:
        li.append("</ol></li>")
    if has_index:
        li.append('<li><a href="text/index.xhtml">Index</a></li>')
    body = (
        '<nav epub:type="toc" id="toc">\n<h1>Contents</h1>\n<ol>\n'
        + "\n".join(li)
        + "\n</ol>\n</nav>"
    )
    return _xhtml_doc(f"{book_title} - Contents", body,
                      css_href="css/style.css", epub_ns=True)


def _ncx_doc(entries, identifier, book_title):
    """Legacy NCX table of contents for older readers."""
    if not isinstance(entries, list) or not entries:
        raise ValueError("_ncx_doc: entries must be a non-empty list")
    pts = []
    for i, (label, href) in enumerate(entries, start=1):
        pts.append(
            f'<navPoint id="np-{i}" playOrder="{i}">'
            f"<navLabel><text>{esc(label)}</text></navLabel>"
            f'<content src="{esc(href)}" /></navPoint>'
        )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        "<head>\n"
        f'<meta name="dtb:uid" content="{esc(identifier)}" />\n'
        '<meta name="dtb:depth" content="1" />\n'
        '<meta name="dtb:totalPageCount" content="0" />\n'
        '<meta name="dtb:maxPageNumber" content="0" />\n'
        "</head>\n"
        f"<docTitle><text>{esc(book_title)}</text></docTitle>\n"
        "<navMap>\n" + "\n".join(pts) + "\n</navMap>\n</ncx>\n"
    )


# ---------------------------------------------------------------------------
# Package document (content.opf)
# ---------------------------------------------------------------------------
def _opf_doc(meta, identifier, manifest, spine):
    """Build content.opf. manifest: [(id, href, media_type, properties)],
    spine: [idref, ...]."""
    if not isinstance(manifest, list) or not manifest:
        raise ValueError("_opf_doc: manifest must be a non-empty list")
    if not isinstance(spine, list) or not spine:
        raise ValueError("_opf_doc: spine must be a non-empty list")
    if not isinstance(meta, dict):
        meta = {}
    md = [
        f'<dc:identifier id="pub-id">{esc(identifier)}</dc:identifier>',
        f'<dc:title id="title">{esc(meta.get("title", "Untitled"))}</dc:title>',
        '<meta refines="#title" property="title-type">main</meta>',
    ]
    if meta.get("subtitle"):
        md.append(f'<dc:title id="subtitle">{esc(meta["subtitle"])}</dc:title>')
        md.append('<meta refines="#subtitle" property="title-type">subtitle</meta>')
    if meta.get("author"):
        md.append(f'<dc:creator id="creator">{esc(meta["author"])}</dc:creator>')
    if meta.get("description"):
        md.append(f"<dc:description>{esc(meta['description'])}</dc:description>")
    md.append("<dc:language>en</dc:language>")
    md.append(f'<meta property="dcterms:modified">{_modified_stamp(meta)}</meta>')
    mf = []
    for mid, href, mtype, props in manifest:
        p = f' properties="{esc(props)}"' if props else ""
        mf.append(f'<item id="{esc(mid)}" href="{esc(href)}" '
                  f'media-type="{esc(mtype)}"{p} />')
    sp = [f'<itemref idref="{esc(idref)}" />' for idref in spine]
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        'unique-identifier="pub-id" xml:lang="en">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        + "\n".join(md) + "\n</metadata>\n<manifest>\n"
        + "\n".join(mf) + "\n</manifest>\n"
        + '<spine toc="ncx">\n' + "\n".join(sp) + "\n</spine>\n</package>\n"
    )


_CONTAINER_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<container version="1.0" '
    'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    "<rootfiles>\n"
    '<rootfile full-path="OEBPS/content.opf" '
    'media-type="application/oebps-package+xml" />\n'
    "</rootfiles>\n</container>\n"
)


# ---------------------------------------------------------------------------
# Item planning: assign one xhtml file per render item
# ---------------------------------------------------------------------------
def _plan_items(data):
    """Return (items_with_files, nid_to_file). Falls back to tree_order when
    meta.structure is absent. Items referencing missing nodes are skipped
    with a warning rather than crashing."""
    if not isinstance(data, dict):
        raise TypeError("_plan_items expects a dict")
    nodes = data.get("nodes", {}) or {}
    items = structured_items(data)
    if items is None:
        items = [{"kind": "node", "nid": nid} for nid, _depth in tree_order(data)]
    planned = []
    nid_to_file = {}
    counters = {"front": 0, "part": 0, "chapter": 0, "epilogue": 0, "node": 0}
    for it in items:
        kind = it.get("kind")
        if kind not in counters:
            print(f"  Warning: unknown item kind {kind!r}; skipped.")
            continue
        counters[kind] += 1
        n = counters[kind]
        if kind == "part":
            it = dict(it)
            it["file"] = f"part-{n:02d}.xhtml"
            planned.append(it)
            continue
        nid = it.get("nid")
        if nid is None or nid not in nodes:
            print(f"  Warning: {kind} references missing node {nid!r}; skipped.")
            continue
        it = dict(it)
        it["file"] = f"{kind}-{n:02d}-{_slug(nid)}.xhtml"
        nid_to_file[str(nid)] = it["file"]
        planned.append(it)
    if not any(it.get("nid") for it in planned):
        raise ValueError("no renderable nodes found in the book structure")
    return planned, nid_to_file


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def build_epub(json_path, output_path=None):
    """Build an EPUB 3 from a .entropy.json file. Returns the output Path."""
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

    meta = data.get("meta", {}) or {}
    base_dir = json_path.parent
    identifier = _stable_identifier(meta)
    book_title = meta.get("title", "Untitled")

    items, nid_to_file = _plan_items(data)

    # ---- build all content documents -------------------------------------
    registry = {}   # sha1 -> {name, mime, data}
    stats = {"img_found": 0, "img_failed": 0}
    docs = {}       # arcname under OEBPS/text/ -> xhtml string
    docs["titlepage.xhtml"] = _titlepage_doc(meta)

    for it in items:
        if it["kind"] == "part":
            docs[it["file"]] = _part_doc(it["num"], it["title"])
            continue
        nid = it["nid"]
        node = nodes.get(nid, {})
        if it["kind"] == "chapter":
            eyebrow = f'<p class="chapter-num">Chapter {it["num"]}</p>'
        elif it["kind"] == "epilogue":
            eyebrow = '<p class="chapter-num chapter-ep">Epilogue</p>'
        else:
            eyebrow = ""
        docs[it["file"]] = _node_doc(node, nid, nodes, base_dir, eyebrow,
                                     registry, stats, nid_to_file)

    index_doc = _index_doc(data, nid_to_file)
    has_index = index_doc is not None
    if has_index:
        docs["index.xhtml"] = index_doc

    nav = _nav_doc(items, nodes, has_index, book_title)
    entries = _nav_entries(items, nodes, nid_to_file, has_index)
    ncx = _ncx_doc(entries, identifier, book_title)

    # ---- pre-zip validation: every document must be well-formed XML ------
    bad = []
    for name, doc in [("OEBPS/nav.xhtml", nav), ("OEBPS/toc.ncx", ncx)] + [
            (f"OEBPS/text/{n}", d) for n, d in docs.items()]:
        try:
            _assert_parses(name, doc)
        except ValueError as exc:
            bad.append(str(exc))
    for name, doc in docs.items():
        if doc.count("</body>") != 1:
            bad.append(f"watermark contract violated in OEBPS/text/{name}: "
                       f"expected exactly one literal </body>, "
                       f"found {doc.count('</body>')}")
    if bad:
        print("Error: generated documents failed validation:")
        for b in bad:
            print(f"  - {b}")
        sys.exit(1)

    # ---- manifest + spine -------------------------------------------------
    manifest = [
        ("nav", "nav.xhtml", "application/xhtml+xml", "nav"),
        ("ncx", "toc.ncx", "application/x-dtbncx+xml", ""),
        ("css-style", "css/style.css", "text/css", ""),
    ]
    spine = []
    for name in docs:  # dict preserves insertion order = reading order
        mid = "t-" + _slug(Path(name).stem)
        manifest.append((mid, f"text/{name}", "application/xhtml+xml", ""))
        spine.append(mid)
    for info in registry.values():
        mid = _slug(Path(info["name"]).stem)
        manifest.append((mid, f"images/{info['name']}", info["mime"], ""))

    mids = [m[0] for m in manifest]
    if len(mids) != len(set(mids)):
        print("Error: duplicate manifest ids generated.")
        sys.exit(1)

    opf = _opf_doc(meta, identifier, manifest, spine)
    try:
        _assert_parses("OEBPS/content.opf", opf)
        _assert_parses("META-INF/container.xml", _CONTAINER_XML)
    except ValueError as exc:
        print(f"Error: {exc}")
        sys.exit(1)

    # ---- write the zip (mimetype first, STORED) ---------------------------
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        mi = zipfile.ZipInfo("mimetype")
        mi.compress_type = zipfile.ZIP_STORED
        zf.writestr(mi, "application/epub+zip")

        def _w(arcname, payload):
            if isinstance(payload, str):
                payload = payload.encode("utf-8")
            zf.writestr(zipfile.ZipInfo(arcname), payload,
                        compress_type=zipfile.ZIP_DEFLATED)

        _w("META-INF/container.xml", _CONTAINER_XML)
        _w("OEBPS/content.opf", opf)
        _w("OEBPS/nav.xhtml", nav)
        _w("OEBPS/toc.ncx", ncx)
        _w("OEBPS/css/style.css", EPUB_CSS)
        for name, doc in docs.items():
            _w(f"OEBPS/text/{name}", doc)
        for info in registry.values():
            _w(f"OEBPS/images/{info['name']}", info["data"])

    if output_path is None:
        output_path = json_path.with_suffix(".epub")
    else:
        output_path = Path(output_path).resolve()

    try:
        output_path.write_bytes(buf.getvalue())
    except OSError as exc:
        # output likely locked (open in a reader) -> write a sibling file
        alt = output_path.with_stem(output_path.stem + "_new")
        print(f"  Could not write {output_path.name} ({exc}); "
              f"writing {alt.name} instead.")
        alt.write_bytes(buf.getvalue())
        output_path = alt

    n_chapters = sum(1 for it in items if it["kind"] != "part")
    size_kb = output_path.stat().st_size / 1024
    print(f"\nEPUB generated: {output_path}")
    print(f"  Content documents: {len(docs)} "
          f"({n_chapters} node sections, "
          f"{sum(1 for it in items if it['kind'] == 'part')} part dividers, "
          f"title page{', index' if has_index else ''})")
    print(f"  Images: {stats['img_found']} found in markdown, "
          f"{len(registry)} unique files written, "
          f"{stats['img_failed']} failed/replaced")
    print(f"  File size: {size_kb:.0f} KB")

    ok = run_self_checks(output_path)
    if not ok:
        print("Error: post-build self-checks FAILED.")
        sys.exit(1)
    return output_path


# ---------------------------------------------------------------------------
# Post-build self-checks (reopen the finished zip and verify everything)
# ---------------------------------------------------------------------------
def run_self_checks(epub_path):
    """Reopen the EPUB and verify structural invariants. Returns True/False."""
    epub_path = Path(epub_path)
    if not epub_path.exists():
        print("  [FAIL] self-check: file does not exist")
        return False
    ok = True

    def report(passed, label):
        nonlocal ok
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        if not passed:
            ok = False

    try:
        zf = zipfile.ZipFile(epub_path)
    except zipfile.BadZipFile as exc:
        print(f"  [FAIL] not a readable zip: {exc}")
        return False

    with zf:
        infos = zf.infolist()
        names = [i.filename for i in infos]

        # 1. mimetype first, stored, exact content
        first_ok = bool(infos) and infos[0].filename == "mimetype"
        stored_ok = first_ok and infos[0].compress_type == zipfile.ZIP_STORED
        content_ok = first_ok and zf.read("mimetype") == b"application/epub+zip"
        report(first_ok, "mimetype is the first zip entry")
        report(stored_ok, "mimetype is STORED (uncompressed)")
        report(content_ok, "mimetype content is exactly application/epub+zip")

        # 2. every .xhtml (and .opf/.ncx/.xml) parses as XML
        bad_xml = []
        for n in names:
            if n.endswith((".xhtml", ".opf", ".ncx", ".xml")):
                try:
                    ET.fromstring(zf.read(n).decode("utf-8"))
                except (ET.ParseError, UnicodeDecodeError) as exc:
                    bad_xml.append(f"{n}: {exc}")
        report(not bad_xml, f"all XML/XHTML documents parse "
                            f"({len(bad_xml)} failures)" if bad_xml else
                            "all XML/XHTML documents parse with ElementTree")
        for b in bad_xml:
            print(f"         {b}")

        # 3. manifest <-> zip cross-check
        try:
            opf_root = ET.fromstring(zf.read("OEBPS/content.opf").decode("utf-8"))
        except (KeyError, ET.ParseError) as exc:
            report(False, f"content.opf readable ({exc})")
            return False
        ns = {"opf": "http://www.idpf.org/2007/opf"}
        manifest_items = opf_root.findall(".//opf:manifest/opf:item", ns)
        manifest_hrefs = {"OEBPS/" + it.get("href", "") for it in manifest_items}
        manifest_ids = {it.get("id") for it in manifest_items}
        zip_files = set(names) - {"mimetype", "META-INF/container.xml",
                                  "OEBPS/content.opf"}
        missing_in_manifest = zip_files - manifest_hrefs
        missing_in_zip = manifest_hrefs - zip_files
        report(not missing_in_manifest,
               "every zip file (except mimetype/container/opf) is in the manifest")
        for m in sorted(missing_in_manifest):
            print(f"         not in manifest: {m}")
        report(not missing_in_zip, "every manifest item exists in the zip")
        for m in sorted(missing_in_zip):
            print(f"         not in zip: {m}")

        # 4. spine references resolve to manifest ids
        spine = opf_root.find(".//opf:spine", ns)
        idrefs = [ir.get("idref") for ir in spine.findall("opf:itemref", ns)] \
            if spine is not None else []
        spine_ok = (spine is not None and idrefs
                    and all(r in manifest_ids for r in idrefs)
                    and spine.get("toc") in manifest_ids)
        report(spine_ok, f"spine valid: {len(idrefs)} itemrefs resolve, "
                         f"toc attribute resolves")

        # 5. watermark contract on every content document
        wm_bad = []
        for n in names:
            if n.startswith("OEBPS/text/") and n.endswith(".xhtml"):
                if zf.read(n).decode("utf-8").count("</body>") != 1:
                    wm_bad.append(n)
        report(not wm_bad, "watermark contract: each text/*.xhtml contains "
                           "exactly one literal </body>")
        for b in wm_bad:
            print(f"         violates contract: {b}")

        # 6. image census
        imgs = [n for n in names if n.startswith("OEBPS/images/")]
        report(True, f"images packaged: {len(imgs)} files under OEBPS/images/")

    return ok


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: py entropy_to_epub.py <input.entropy.json> [output.epub]")
        sys.exit(1)
    in_file = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    build_epub(in_file, out_file)
