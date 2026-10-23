#!/usr/bin/env python
"""
docx_to_entropy.py — Convert a Word document (.docx) to an entropy editor .json file.

Chapters are split on Word's "Heading 1" style. Everything between one Heading 1
and the next becomes that chapter's content. Text before the first Heading 1
becomes an "intro" node, which is used as the book root.

Mapping (Word -> entropy):
  Title style              -> meta.title (unless --title given)
  Heading 1                -> new chapter node (title = heading text)
  Heading 2/3/4            -> markdown ##/###/#### inside the chapter
  bold / italic runs       -> **bold** / *italic* / ***both***
  bulleted list paragraph  -> "- item"
  numbered list paragraph  -> "1. item"
  Quote / Intense Quote    -> "> quoted"
  hyperlinks               -> [text](url)

Not converted (skipped with a warning): tables, images, footnotes/endnotes.

Usage:
  py docx_to_entropy.py "My Book.docx"
  py docx_to_entropy.py "My Book.docx" -o "My Book.json" --title "My Book" --author "Jane Doe"
"""

import argparse
import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

try:
    import docx
    from docx.text.paragraph import Paragraph
except ImportError:
    sys.exit("python-docx is required. Install it with:  py -m pip install python-docx")


# ---------------------------------------------------------------- helpers

HEADING_RE = re.compile(r"^heading\s*(\d)$", re.IGNORECASE)


def heading_level(paragraph):
    """Return 1-9 for Heading N paragraphs, else None."""
    style = paragraph.style
    if style is None:
        return None
    for candidate in (style.name or "", getattr(style, "style_id", "") or ""):
        m = HEADING_RE.match(candidate.strip()) or re.match(
            r"^Heading(\d)$", candidate.strip()
        )
        if m:
            level = int(m.group(1))
            if 1 <= level <= 9:
                return level
    return None


def style_name(paragraph):
    if paragraph.style is None or paragraph.style.name is None:
        return ""
    return paragraph.style.name


def is_list_paragraph(paragraph):
    """True if the paragraph belongs to a list (by numbering XML or style name)."""
    pPr = paragraph._p.pPr
    if pPr is not None and pPr.numPr is not None:
        return True
    return "list" in style_name(paragraph).lower()


def is_numbered(paragraph):
    """Heuristic: 'List Number' styles are numbered; everything else is a bullet."""
    return "number" in style_name(paragraph).lower()


def is_quote(paragraph):
    return "quote" in style_name(paragraph).lower()


def slugify(text, fallback="chapter"):
    """Lowercase ASCII slug, same shape as existing entropy node ids."""
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text or fallback


def run_to_markdown(run):
    """One run -> markdown, escaping nothing (prose passes through as-is)."""
    text = run.text
    if not text or not text.strip():
        return text
    bold = bool(run.bold)
    italic = bool(run.italic)
    # Markdown markers must hug the text, so move surrounding spaces outside.
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()):]
    core = text.strip()
    if bold and italic:
        core = f"***{core}***"
    elif bold:
        core = f"**{core}**"
    elif italic:
        core = f"*{core}*"
    return f"{lead}{core}{trail}"


def paragraph_to_markdown(paragraph):
    """Inline content of a paragraph -> markdown string (handles hyperlinks)."""
    parts = []
    try:
        items = list(paragraph.iter_inner_content())
    except AttributeError:  # very old python-docx: no hyperlink support
        items = list(paragraph.runs)
    for item in items:
        if hasattr(item, "address"):  # Hyperlink object
            link_text = "".join(r.text for r in item.runs).strip()
            if item.address and link_text:
                parts.append(f"[{link_text}]({item.address})")
            else:
                parts.append(link_text)
        else:  # Run
            parts.append(run_to_markdown(item))
    return "".join(parts).strip()


# ---------------------------------------------------------------- conversion

def block_items(document):
    """Yield ('paragraph', Paragraph) / ('table', None) in document order."""
    body = document.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            yield "paragraph", Paragraph(child, document)
        elif tag == "tbl":
            yield "table", None


def convert(docx_path, title_override=None, author_override=None):
    """Read the .docx and return (entropy_dict, warnings_list)."""
    document = docx.Document(str(docx_path))
    warnings = []

    doc_title = None
    chapters = []          # list of {"title": str, "lines": [str]}
    current = None         # chapter being filled; None = before first Heading 1
    intro_lines = []
    tables_skipped = 0
    images_skipped = 0

    for kind, paragraph in block_items(document):
        if kind == "table":
            tables_skipped += 1
            continue

        if paragraph._p.xpath(".//pic:pic | .//w:drawing"):
            images_skipped += 1

        level = heading_level(paragraph)
        text = paragraph_to_markdown(paragraph)

        if style_name(paragraph).lower() == "title" and doc_title is None:
            doc_title = text
            continue

        if level == 1:
            if not text:
                continue  # empty Heading 1 paragraphs don't start chapters
            current = {"title": text, "lines": []}
            chapters.append(current)
            continue

        target = current["lines"] if current is not None else intro_lines

        if not text:
            continue
        if level is not None:  # Heading 2+ inside a chapter
            target.append("#" * min(level, 6) + " " + text)
        elif is_list_paragraph(paragraph):
            target.append(("1. " if is_numbered(paragraph) else "- ") + text)
        elif is_quote(paragraph):
            target.append("> " + text)
        else:
            target.append(text)

    if not chapters:
        raise ValueError(
            "No 'Heading 1' paragraphs found in the document. "
            "Chapters are split on Word's Heading 1 style - apply it to each chapter title."
        )

    if tables_skipped:
        warnings.append(f"{tables_skipped} table(s) skipped - tables are not converted.")
    if images_skipped:
        warnings.append(f"{images_skipped} image(s) skipped - images are not converted.")

    # ---- assemble nodes -------------------------------------------------
    def join_lines(lines):
        # consecutive list items stay adjacent; everything else gets a blank line
        out = []
        prev_list = False
        for line in lines:
            is_list = line.startswith(("- ", "1. "))
            if out:
                out.append("" if not (prev_list and is_list) else None)
            out.append(line)
            prev_list = is_list
        return "\n".join(l for l in out if l is not None).replace("\n\n\n", "\n\n")

    nodes = {}
    used_ids = set()

    def make_id(title):
        base = slugify(title)
        node_id, n = base, 2
        while node_id in used_ids:
            node_id = f"{base}-{n}"
            n += 1
        used_ids.add(node_id)
        return node_id

    def make_node(node_id, title, lines, order):
        return {
            "id": node_id,
            "title": title,
            "summary": "",
            "content": join_lines(lines),
            "children": [],
            "connections": [],
            "media": [],
            "tags": [],
            "order": order,
        }

    order = 10
    chapter_ids = []
    for ch in chapters:
        node_id = make_id(ch["title"])
        nodes[node_id] = make_node(node_id, ch["title"], ch["lines"], order)
        chapter_ids.append(node_id)
        order += 10

    if intro_lines:
        root_id = make_id("intro")
        nodes[root_id] = make_node(root_id, "Introduction", intro_lines, 0)
        nodes[root_id]["children"] = chapter_ids
    else:
        root_id = chapter_ids[0]
        nodes[root_id]["children"] = chapter_ids[1:]

    # ---- metadata --------------------------------------------------------
    core = document.core_properties
    title = (
        title_override
        or doc_title
        or (core.title or "").strip()
        or Path(docx_path).stem
    )
    author = author_override or (core.author or "").strip()
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    data = {
        "meta": {
            "title": title,
            "subtitle": "",
            "author": author,
            "version": "1.0.0",
            "created": now,
            "modified": now,
            "description": "",
            "tags": [],
        },
        "root": root_id,
        "nodes": nodes,
        "themes": {
            "default": "clean",
            "available": ["clean", "academic", "dark", "high-contrast"],
        },
    }
    return data, warnings


def validate(data):
    """Sanity-check the structure before writing — fail loudly, not silently."""
    if data["root"] not in data["nodes"]:
        raise ValueError(f"internal error: root '{data['root']}' missing from nodes")
    for node_id, node in data["nodes"].items():
        if node["id"] != node_id:
            raise ValueError(f"internal error: node key/id mismatch for '{node_id}'")
        for child in node["children"]:
            if child not in data["nodes"]:
                raise ValueError(f"internal error: child '{child}' of '{node_id}' missing")
        if not node["title"].strip():
            raise ValueError(f"internal error: node '{node_id}' has an empty title")


# ---------------------------------------------------------------- main

def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Convert a .docx to an entropy editor .json (chapters split on Heading 1)."
    )
    parser.add_argument("docx", help="path to the Word document (.docx)")
    parser.add_argument("-o", "--output", help="output .json path (default: same name as input)")
    parser.add_argument("--title", help="book title (default: Title style, doc properties, or filename)")
    parser.add_argument("--author", help="author name (default: doc properties)")
    args = parser.parse_args(argv)

    src = Path(args.docx)
    if not src.exists():
        sys.exit(f"error: file not found: {src}")
    if src.suffix.lower() != ".docx":
        sys.exit(f"error: expected a .docx file, got: {src.suffix or '(no extension)'}")

    out = Path(args.output) if args.output else src.with_suffix(".json")
    if out.exists():
        sys.exit(f"error: output already exists, refusing to overwrite: {out}\n"
                 f"       pass -o to choose a different path, or delete it first.")

    try:
        data, warnings = convert(src, args.title, args.author)
        validate(data)
    except ValueError as e:
        sys.exit(f"error: {e}")
    except Exception as e:
        sys.exit(f"error: could not read '{src}': {e}")

    out.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    n = len(data["nodes"])
    chapters = n - (1 if data["root"] == "intro" or data["root"].startswith("intro-") else 0)
    print(f"Wrote {out}")
    print(f"  title:    {data['meta']['title']}")
    print(f"  author:   {data['meta']['author'] or '(none)'}")
    print(f"  chapters: {chapters} (root: {data['root']})")
    for w in warnings:
        print(f"  warning: {w}")


if __name__ == "__main__":
    main()
