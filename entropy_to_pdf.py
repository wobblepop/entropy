#!/usr/bin/env python3
"""
entropy_to_pdf.py - Generate a PDF from an .entropy.json file.

Renders the full node tree as a formatted PDF with:
  - Title page with book metadata
  - Clickable table of contents
  - Markdown content with headings, bold, italic, lists, code, tables, blockquotes
  - Locally referenced images embedded
  - Clickable external hyperlinks
  - Internal cross-reference links (connections and children)
  - Node metadata (difficulty, estimated time, tags)

Usage:
    py entropy_to_pdf.py <input.entropy.json> [output.pdf]

Requires: fpdf2 (py -m pip install fpdf2)
"""

import json
import sys
import re
import os
import logging
from pathlib import Path
from html import escape as html_escape

try:
    from fpdf import FPDF
except ImportError:
    print("fpdf2 is required. Install with: py -m pip install fpdf2")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Font name used throughout — registered as TTF in EntropyPDF.__init__
_F = "Arial"
_FM = "Mono"

CONNECTION_COLORS = {
    "related": "#2b6cb0",
    "prerequisite": "#c05621",
    "deeper": "#6b46c1",
    "example": "#276749",
    "tangent": "#b83280",
}

CONNECTION_LABELS = {
    "related": "Related",
    "prerequisite": "Prerequisite",
    "deeper": "Deeper",
    "example": "Example",
    "tangent": "Tangent",
}

DIFFICULTY_COLORS = {
    "intro": "#38a169",
    "intermediate": "#d69e2e",
    "advanced": "#e53e3e",
    "expert": "#805ad5",
}


# ---------------------------------------------------------------------------
# Markdown -> HTML (subset supported by fpdf2's write_html)
# ---------------------------------------------------------------------------

def _escape(text):
    return html_escape(text, quote=True)


def _inline(text):
    """Convert inline markdown to HTML."""
    text = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r'<img src="\2" alt="\1">', text)
    text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<b><i>\1</i></b>", text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\*(.+?)\*", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", lambda m: f'<font face="{_FM}">{_escape(m.group(1))}</font>', text)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"~~(.+?)~~", r"<s>\1</s>", text)
    return text


def _md_to_html(md_text):
    """Convert a markdown string to the HTML subset fpdf2 can render."""
    if not md_text:
        return ""

    lines = md_text.split("\n")
    parts = []
    in_list = False
    list_tag = ""
    in_code = False
    in_bq = False
    in_table = False

    def _close_list():
        nonlocal in_list, list_tag
        if in_list:
            parts.append(f"</{list_tag}>")
            in_list = False

    def _close_bq():
        nonlocal in_bq
        if in_bq:
            parts.append("</blockquote>")
            in_bq = False

    def _close_table():
        nonlocal in_table
        if in_table:
            parts.append("</tbody></table>")
            in_table = False

    for line in lines:
        # --- code fences ---
        if line.startswith("```"):
            _close_list()
            _close_bq()
            if in_code:
                parts.append("</pre>")
                in_code = False
            else:
                in_code = True
                parts.append("<pre>")
            continue
        if in_code:
            parts.append(_escape(line) + "\n")
            continue

        # --- tables ---
        stripped = line.strip()
        if "|" in stripped and stripped.startswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.match(r"^[-:]+$", c) for c in cells if c):
                continue
            if not in_table:
                _close_list()
                _close_bq()
                in_table = True
                parts.append(
                    '<table border="1"><thead><tr>'
                    + "".join(f"<th>{_inline(c)}</th>" for c in cells)
                    + "</tr></thead><tbody>"
                )
                continue
            parts.append(
                "<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in cells) + "</tr>"
            )
            continue
        else:
            _close_table()

        # --- close running list / blockquote ---
        if in_list and not re.match(r"^\s*[-*+]\s", line) and not re.match(r"^\s*\d+\.\s", line):
            _close_list()
        if in_bq and not line.startswith(">"):
            _close_bq()

        # --- headings ---
        m = re.match(r"^(#{1,6})\s+(.+)", line)
        if m:
            lvl = min(len(m.group(1)) + 1, 6)
            parts.append(f"<h{lvl}>{_inline(m.group(2))}</h{lvl}>")
            continue

        # --- blockquote ---
        if line.startswith(">"):
            content = line.lstrip(">").strip()
            if not in_bq:
                parts.append("<blockquote>")
                in_bq = True
            if content:
                parts.append(f"<p>{_inline(content)}</p>")
            continue

        # --- unordered list ---
        m = re.match(r"^\s*[-*+]\s+(.+)", line)
        if m:
            if not in_list or list_tag != "ul":
                _close_list()
                parts.append("<ul>")
                in_list = True
                list_tag = "ul"
            parts.append(f"<li><p>{_inline(m.group(1))}</p></li>")
            continue

        # --- ordered list ---
        m = re.match(r"^\s*\d+\.\s+(.+)", line)
        if m:
            if not in_list or list_tag != "ol":
                _close_list()
                parts.append("<ol>")
                in_list = True
                list_tag = "ol"
            parts.append(f"<li><p>{_inline(m.group(1))}</p></li>")
            continue

        # --- horizontal rule ---
        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", line):
            parts.append("<hr>")
            continue

        # --- blank line ---
        if not stripped:
            continue

        # --- paragraph ---
        parts.append(f"<p>{_inline(line)}</p>")

    _close_list()
    _close_bq()
    _close_table()
    if in_code:
        parts.append("</pre>")

    return "".join(parts)


def _resolve_img_paths(html, base_dir):
    """Rewrite relative image src attributes to absolute paths."""
    def _repl(match):
        src = match.group(1)
        if os.path.isabs(src) or src.startswith(("http://", "https://")):
            return match.group(0)
        resolved = str((base_dir / src).resolve())
        return f'src="{resolved}"'
    return re.sub(r'src="([^"]+)"', _repl, html)


# ---------------------------------------------------------------------------
# Tree traversal
# ---------------------------------------------------------------------------

def _tree_order(data):
    """Depth-first walk following children arrays. Returns [(node_id, depth), ...]."""
    root_id = data.get("root")
    nodes = data.get("nodes", {})
    order = []
    visited = set()

    def _walk(nid, depth):
        if nid in visited or nid not in nodes:
            return
        visited.add(nid)
        order.append((nid, depth))
        for child in nodes[nid].get("children", []):
            _walk(child, depth + 1)

    if root_id:
        _walk(root_id, 0)

    for nid in nodes:
        if nid not in visited:
            order.append((nid, 0))

    return order


# ---------------------------------------------------------------------------
# PDF class
# ---------------------------------------------------------------------------

class EntropyPDF(FPDF):
    def __init__(self, book_title):
        super().__init__(orientation="P", unit="mm", format="Letter")
        self._book_title = book_title
        self._skip_header_pages = set()
        self.set_auto_page_break(auto=True, margin=20)
        self._register_fonts()

    def _register_fonts(self):
        """Register TTF fonts for full Unicode support."""
        global _F, _FM
        font_dir = Path("C:/Windows/Fonts")
        try:
            self.add_font("Arial", "", str(font_dir / "arial.ttf"))
            self.add_font("Arial", "B", str(font_dir / "arialbd.ttf"))
            self.add_font("Arial", "I", str(font_dir / "ariali.ttf"))
            self.add_font("Arial", "BI", str(font_dir / "arialbi.ttf"))
            self.add_font("Mono", "", str(font_dir / "cour.ttf"))
            self.add_font("Mono", "B", str(font_dir / "courbd.ttf"))
            _F = "Arial"
            _FM = "Mono"
            fallbacks = []
            for name, fname in [
                ("Emoji", "seguiemj.ttf"),
                ("Sym", "seguisym.ttf"),
                ("CJK", "msyh.ttc"),
            ]:
                path = font_dir / fname
                if path.exists():
                    try:
                        self.add_font(name, "", str(path))
                        fallbacks.append(name)
                    except Exception:
                        pass
            if fallbacks:
                self.set_fallback_fonts(fallbacks)
        except Exception:
            _F = "Helvetica"
            _FM = "Courier"

    def mark_no_header(self):
        self._skip_header_pages.add(self.page_no())

    def header(self):
        if self.page_no() in self._skip_header_pages:
            return
        self.set_font(_F, "I", 8)
        self.set_text_color(130, 130, 130)
        self.cell(0, 8, self._book_title, new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(200, 200, 200)
        y = self.get_y()
        self.line(self.l_margin, y, self.w - self.r_margin, y)
        self.ln(4)

    def footer(self):
        if self.page_no() in self._skip_header_pages:
            return
        self.set_y(-15)
        self.set_font(_F, "I", 8)
        self.set_text_color(130, 130, 130)
        self.cell(0, 10, str(self.page_no()), align="C")


# ---------------------------------------------------------------------------
# Hex color helper
# ---------------------------------------------------------------------------

def _hex_rgb(hex_color):
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


# ---------------------------------------------------------------------------
# Main generator
# ---------------------------------------------------------------------------

def generate_pdf(json_path, output_path=None):
    json_path = Path(json_path).resolve()
    if not json_path.exists():
        print(f"Error: file not found: {json_path}")
        sys.exit(1)

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    meta = data.get("meta", {})
    nodes = data.get("nodes", {})
    base_dir = json_path.parent
    book_title = meta.get("title", "Untitled")

    if output_path is None:
        output_path = json_path.with_suffix(".pdf")
    else:
        output_path = Path(output_path).resolve()

    tree = _tree_order(data)

    logging.getLogger("fpdf2").setLevel(logging.ERROR)
    logging.getLogger("fpdf").setLevel(logging.ERROR)
    logging.getLogger("fpdf.html").setLevel(logging.ERROR)
    logging.getLogger("fontTools").setLevel(logging.ERROR)

    pdf = EntropyPDF(book_title)
    pdf.set_margins(25, 20, 25)
    content_width = pdf.w - pdf.l_margin - pdf.r_margin

    # ==================================================================
    # Title page
    # ==================================================================
    pdf.add_page()
    pdf.mark_no_header()

    # create internal link targets AFTER the first page exists
    node_links = {}
    for nid, _ in tree:
        node_links[nid] = pdf.add_link()

    pdf.ln(50)
    pdf.set_font(_F, "B", 28)
    pdf.set_text_color(26, 54, 93)
    pdf.multi_cell(0, 14, book_title, align="C")

    if meta.get("subtitle"):
        pdf.ln(5)
        pdf.set_font(_F, "I", 16)
        pdf.set_text_color(100, 100, 100)
        pdf.multi_cell(0, 10, meta["subtitle"], align="C")

    if meta.get("author"):
        pdf.ln(10)
        pdf.set_font(_F, "", 14)
        pdf.set_text_color(80, 80, 80)
        pdf.multi_cell(0, 8, meta["author"], align="C")

    if meta.get("description"):
        pdf.ln(15)
        pdf.set_font(_F, "", 11)
        pdf.set_text_color(80, 80, 80)
        pdf.multi_cell(0, 6, meta["description"], align="C")

    version_parts = []
    if meta.get("version"):
        version_parts.append(f"Version {meta['version']}")
    if meta.get("modified"):
        version_parts.append(meta["modified"][:10])
    if version_parts:
        pdf.ln(10)
        pdf.set_font(_F, "", 9)
        pdf.set_text_color(150, 150, 150)
        pdf.multi_cell(0, 6, "  |  ".join(version_parts), align="C")

    if meta.get("tags"):
        pdf.ln(5)
        pdf.set_font(_F, "I", 9)
        pdf.set_text_color(150, 150, 150)
        pdf.multi_cell(0, 5, ", ".join(meta["tags"]), align="C")

    # ==================================================================
    # Table of Contents
    # ==================================================================
    pdf.add_page()

    pdf.set_font(_F, "B", 20)
    pdf.set_text_color(26, 54, 93)
    pdf.cell(0, 12, "Table of Contents", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(6)

    for nid, depth in tree:
        node = nodes[nid]
        indent = depth * 8
        pdf.set_x(pdf.l_margin + indent)

        difficulty = node.get("difficulty", "")
        if difficulty in DIFFICULTY_COLORS:
            r, g, b = _hex_rgb(DIFFICULTY_COLORS[difficulty])
            pdf.set_fill_color(r, g, b)
            cx = pdf.get_x() + 1.5
            cy = pdf.get_y() + 3
            pdf.circle(cx, cy, 1.5, style="F")
            pdf.set_x(pdf.get_x() + 5)

        pdf.set_font(_F, "", 10)
        pdf.set_text_color(43, 108, 176)
        title = node.get("title", nid)
        remaining = pdf.w - pdf.r_margin - pdf.get_x()
        pdf.cell(remaining, 6, title, link=node_links[nid], new_x="LMARGIN", new_y="NEXT")

        if pdf.get_y() > pdf.h - 25:
            pdf.add_page()

    # Difficulty legend
    pdf.ln(8)
    pdf.set_font(_F, "I", 8)
    pdf.set_text_color(130, 130, 130)

    pdf.set_x(pdf.l_margin)
    for diff_name, diff_color in DIFFICULTY_COLORS.items():
        r, g, b = _hex_rgb(diff_color)
        pdf.set_fill_color(r, g, b)
        cx = pdf.get_x() + 1.5
        cy = pdf.get_y() + 2.5
        pdf.circle(cx, cy, 1.5, style="F")
        pdf.set_x(pdf.get_x() + 4)
        pdf.set_text_color(100, 100, 100)
        w = pdf.get_string_width(diff_name) + 6
        pdf.cell(w, 5, diff_name)

    pdf.ln(10)

    # ==================================================================
    # Content pages — one page per node
    # ==================================================================
    for nid, depth in tree:
        node = nodes[nid]
        title = node.get("title", nid)

        pdf.add_page()
        pdf.set_link(node_links[nid])

        # -- node title --
        size = max(22 - depth * 2, 14)
        pdf.set_font(_F, "B", size)
        pdf.set_text_color(26, 54, 93)
        pdf.multi_cell(0, size * 0.55, title)
        pdf.ln(2)

        # -- metadata bar --
        meta_bits = []
        if node.get("difficulty"):
            meta_bits.append(node["difficulty"].capitalize())
        if node.get("estimatedTime"):
            meta_bits.append(node["estimatedTime"])
        if node.get("tags"):
            meta_bits.append(", ".join(node["tags"]))

        if meta_bits:
            pdf.set_font(_F, "I", 8)
            pdf.set_text_color(130, 130, 130)
            pdf.cell(0, 5, "  ·  ".join(meta_bits), new_x="LMARGIN", new_y="NEXT")
            pdf.ln(2)

        # -- summary --
        if node.get("summary"):
            pdf.set_font(_F, "I", 10)
            pdf.set_text_color(100, 100, 100)
            pdf.multi_cell(0, 6, node["summary"])
            pdf.ln(3)

        # -- divider --
        pdf.set_draw_color(200, 200, 200)
        y = pdf.get_y()
        pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
        pdf.ln(5)

        # -- markdown content --
        content_html = _md_to_html(node.get("content", ""))
        content_html = _resolve_img_paths(content_html, base_dir)
        if content_html:
            pdf.set_font(_F, "", 10)
            pdf.set_text_color(45, 55, 72)
            try:
                pdf.write_html(content_html)
            except Exception as exc:
                print(f"  Warning: render error on node '{nid}': {exc}")
        try:
            pdf.ln(5)
        except Exception:
            pass

        # -- media --
        for item in node.get("media", []):
            mtype = item.get("type", "")
            src = item.get("src", "")

            if mtype in ("image", "diagram"):
                img_path = (base_dir / src).resolve()
                if img_path.exists() and img_path.is_file():
                    if pdf.get_y() > pdf.h - 80:
                        pdf.add_page()
                    try:
                        pdf.image(str(img_path), w=min(content_width, 150))
                    except Exception as exc:
                        pdf.set_font(_F, "I", 9)
                        pdf.set_text_color(180, 0, 0)
                        pdf.cell(0, 5, f"[Image error: {exc}]", new_x="LMARGIN", new_y="NEXT")
                    if item.get("caption"):
                        pdf.set_font(_F, "I", 8)
                        pdf.set_text_color(100, 100, 100)
                        pdf.multi_cell(0, 5, item["caption"], align="C")
                    pdf.ln(5)
                else:
                    pdf.set_font(_F, "I", 9)
                    pdf.set_text_color(180, 0, 0)
                    pdf.cell(0, 5, f"[Image not found: {src}]", new_x="LMARGIN", new_y="NEXT")

            elif mtype in ("video", "audio", "embed"):
                label = item.get("caption") or item.get("alt") or src
                pdf.set_font(_F, "I", 9)
                pdf.set_text_color(100, 100, 100)
                pdf.cell(0, 5, f"[{mtype.capitalize()}: {label}]", new_x="LMARGIN", new_y="NEXT")

        # -- connections (See Also) --
        connections = node.get("connections", [])
        children = node.get("children", [])
        has_footer = bool(connections or children)

        if has_footer:
            pdf.ln(3)
            pdf.set_draw_color(200, 200, 200)
            y = pdf.get_y()
            pdf.line(pdf.l_margin, y, pdf.w - pdf.r_margin, y)
            pdf.ln(4)

        if connections:
            pdf.set_font(_F, "B", 9)
            pdf.set_text_color(80, 80, 80)
            pdf.cell(0, 6, "See Also", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)

            for conn in connections:
                target_id = conn.get("to", "")
                conn_type = conn.get("type", "related")
                label = conn.get("label", "")
                target_node = nodes.get(target_id, {})
                target_title = target_node.get("title", target_id)
                display = label if label else target_title

                r, g, b = _hex_rgb(CONNECTION_COLORS.get(conn_type, "#666666"))
                type_label = CONNECTION_LABELS.get(conn_type, conn_type.capitalize())

                pdf.set_font(_F, "B", 8)
                pdf.set_text_color(r, g, b)
                badge_w = pdf.get_string_width(type_label) + 4
                pdf.cell(badge_w, 5, type_label, new_x="END")

                pdf.set_font(_F, "", 9)
                pdf.set_text_color(43, 108, 176)
                link = node_links.get(target_id)
                if link:
                    pdf.cell(0, 5, f"  {display}", link=link, new_x="LMARGIN", new_y="NEXT")
                else:
                    pdf.set_text_color(100, 100, 100)
                    pdf.cell(0, 5, f"  {display}", new_x="LMARGIN", new_y="NEXT")

            pdf.ln(2)

        if children:
            pdf.set_font(_F, "B", 9)
            pdf.set_text_color(80, 80, 80)
            pdf.cell(0, 6, "In This Section", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)

            for cid in children:
                child_node = nodes.get(cid, {})
                child_title = child_node.get("title", cid)
                pdf.set_font(_F, "", 9)
                pdf.set_text_color(43, 108, 176)
                link = node_links.get(cid)
                pdf.set_x(pdf.l_margin + 4)
                if link:
                    pdf.cell(0, 5, f"-  {child_title}", link=link, new_x="LMARGIN", new_y="NEXT")
                else:
                    pdf.set_text_color(100, 100, 100)
                    pdf.cell(0, 5, f"-  {child_title}", new_x="LMARGIN", new_y="NEXT")

    # ==================================================================
    # Save
    # ==================================================================
    try:
        pdf.output(str(output_path))
    except PermissionError:
        stem = output_path.stem
        alt = output_path.with_stem(f"{stem}_new")
        print(f"  File locked: {output_path.name} (close it first)")
        print(f"  Writing to: {alt.name}")
        pdf.output(str(alt))
        output_path = alt
    print(f"PDF generated: {output_path}")
    print(f"  Nodes: {len(tree)}")
    print(f"  Pages: {pdf.page_no()}")
    return output_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: py entropy_to_pdf.py <input.entropy.json> [output.pdf]")
        sys.exit(1)

    in_file = sys.argv[1]
    out_file = sys.argv[2] if len(sys.argv) > 2 else None
    generate_pdf(in_file, out_file)
