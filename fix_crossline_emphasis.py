#!/usr/bin/env python3
"""Repair emphasis markers that span a soft line break in a book's node content.

Before 2026-10-24 the editor serialized italic/bold/strikethrough/code that crossed a
Shift+Enter line break as "*line one\\nline two*". Every parser (editor, reader, HTML,
PDF, EPUB) works line by line, so that text re-read as literal asterisks and the
emphasis was gone. The serializer now wraps each line on its own ("*line one*\\n*line
two*"); this script brings already-saved files up to that form.

It is conservative: a paragraph is rewritten only when every marker in it opens and
closes in strict nesting order and at least one line ends with a marker still open that
a later line of the same paragraph closes. Paragraphs with unmatched or crossed markers
are reported and left alone. Fenced code and footnote definition lines are skipped.

Usage:
    py fix_crossline_emphasis.py <book.entropy.json>            # dry run: report only
    py fix_crossline_emphasis.py <book.entropy.json> --apply    # rewrite (keeps a .bak)
"""
import json
import re
import shutil
import sys
from pathlib import Path

MARKER_RE = re.compile(r"\*{1,3}|~~|`")
BLOCK_START_RE = re.compile(r"^(\s*)(#{1,6}\s|[-*+]\s|\d+\.\s|\||:::|\[\^[A-Za-z0-9_-]+\]:|(?:-{3,}|\*{3,}|_{3,})\s*$)")
QUOTE_RE = re.compile(r"^(>\s?)(.*)$")


def _scan_line(text, stack):
    """Walk one line's markers, updating `stack` (open markers, outermost first).
    Returns False when a marker is ambiguous (closer that is not the innermost open
    marker, or an opener while code is open is fine; '*' inside code is ignored)."""
    pos = 0
    for m in MARKER_RE.finditer(text):
        tok = m.group(0)
        before = text[m.start() - 1] if m.start() > 0 else ""
        after = text[m.end()] if m.end() < len(text) else ""
        in_code = bool(stack) and stack[-1] == "`"
        if in_code:
            if tok == "`":
                stack.pop()
            continue  # emphasis markers inside code are literal
        if stack and stack[-1] == tok and before and not before.isspace():
            stack.pop()                     # closes the innermost open marker
            continue
        if after and not after.isspace():
            if tok in stack:
                return False                # would re-open a marker that is already open
            stack.append(tok)
            continue
        # space-flanked or trailing marker: literal text, no change
    return True


def _repair_paragraph(lines, prefixes):
    """lines: paragraph lines with any blockquote prefix removed; prefixes: those prefixes.
    Returns (new_lines, changed) or (None, False) when the paragraph is unclear."""
    stack = []
    carried = []          # markers open at the end of the previous line
    out = []
    changed = False
    for idx, line in enumerate(lines):
        stack = list(carried)
        if not _scan_line(line, stack):
            return None, False
        open_now = list(stack)
        new_line = line
        if carried:
            lead = re.match(r"^\s*", new_line).group(0)
            new_line = lead + "".join(carried) + new_line[len(lead):]
            changed = True
        if open_now and idx < len(lines) - 1:
            trail = re.search(r"\s*$", new_line).group(0)
            core = new_line[: len(new_line) - len(trail)]
            new_line = core + "".join(reversed(open_now)) + trail
            changed = True
        out.append(prefixes[idx] + new_line)
        carried = open_now
    if carried:
        return None, False                 # never closed: not a cross-line leak
    return out, changed


def repair_content(content):
    """Returns (new_content, reports) where reports is a list of (before, after) or
    (before, None) for paragraphs left alone because they were unclear."""
    lines = content.split("\n")
    out = []
    reports = []
    i = 0
    in_code = False
    while i < len(lines):
        line = lines[i]
        if line.startswith("```"):
            in_code = not in_code
            out.append(line)
            i += 1
            continue
        if in_code or not line.strip() or BLOCK_START_RE.match(line):
            out.append(line)
            i += 1
            continue
        # a paragraph run: consecutive non-blank, non-block lines (quotes keep their prefix)
        run, prefixes = [], []
        quoted = line.startswith(">")
        while i < len(lines) and lines[i].strip() and not lines[i].startswith("```") \
                and not BLOCK_START_RE.match(lines[i]) and lines[i].startswith(">") == quoted:
            q = QUOTE_RE.match(lines[i]) if quoted else None
            prefixes.append(q.group(1) if q else "")
            run.append(q.group(2) if q else lines[i])
            i += 1
        if len(run) < 2:
            out.extend(prefixes[k] + run[k] for k in range(len(run)))
            continue
        new_run, changed = _repair_paragraph(run, prefixes)
        if new_run is None:
            # unclear only matters if a line ends with something open; detect cheaply
            probe = []
            flagged = False
            for ln in run:
                s = list(probe)
                ok = _scan_line(ln, s)
                if not ok or s:
                    flagged = True
                    break
                probe = s
            if flagged:
                reports.append(("\n".join(prefixes[k] + run[k] for k in range(len(run))), None))
            out.extend(prefixes[k] + run[k] for k in range(len(run)))
            continue
        if changed:
            reports.append(("\n".join(prefixes[k] + run[k] for k in range(len(run))), "\n".join(new_run)))
            out.extend(new_run)
        else:
            out.extend(prefixes[k] + run[k] for k in range(len(run)))
    return "\n".join(out), reports


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 2
    path = Path(argv[1])
    apply = "--apply" in argv[2:]
    unknown = [a for a in argv[2:] if a != "--apply"]
    if unknown:
        print("Unknown argument(s): " + " ".join(unknown))
        return 2
    if not path.is_file():
        print(f"Not a file: {path}")
        return 2
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"Could not read {path}: {exc}")
        return 1
    nodes = data.get("nodes") if isinstance(data, dict) else None
    if not isinstance(nodes, dict):
        print("Not a book: no 'nodes' object.")
        return 1

    total_fixed = total_unclear = 0
    for nid, node in nodes.items():
        if not isinstance(node, dict) or not isinstance(node.get("content"), str):
            continue
        new_content, reports = repair_content(node["content"])
        for before, after in reports:
            if after is None:
                total_unclear += 1
                print(f"[{nid}] UNCLEAR (left unchanged):")
                for ln in before.split("\n"):
                    print("    | " + ln)
            else:
                total_fixed += 1
                print(f"[{nid}] cross-line markers:")
                for ln in before.split("\n"):
                    print("    - " + ln)
                for ln in after.split("\n"):
                    print("    + " + ln)
        if apply and new_content != node["content"]:
            node["content"] = new_content

    print(f"\n{total_fixed} paragraph(s) with cross-line markers, {total_unclear} unclear, "
          f"in {len(nodes)} nodes")
    if apply and total_fixed:
        bak = path.with_name(path.name + ".pre-crossline-fix.bak")
        shutil.copyfile(path, bak)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Rewrote {path} (backup: {bak.name})")
    elif apply:
        print("Nothing to apply.")
    else:
        print("Dry run: nothing written. Re-run with --apply to rewrite the file.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
