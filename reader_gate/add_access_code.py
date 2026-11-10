#!/usr/bin/env python3
"""
add_access_code.py - Add a freshly generated access code to the codes file.

The codes file is the box-drawn table build_chickenwhispering_multi.py reads
(Label | Code | Opens). This script generates a random code, appends a row,
rewrites the table, and re-reads it to prove every existing row survived
unchanged. It NEVER prints a code: open the codes file to read the new one.

Usage (from the entropy folder):
    py reader_gate/add_access_code.py --codes-file "../frauddyscotty/codes.txt" \
        --label students1 --opens textbook

    --opens            'all' or comma-separated edition keys (see EDITION_CATALOG
                       in build_chickenwhispering_multi.py)
    --length N         code length, 10-64 (default 12; 30-symbol alphabet, so
                       12 characters is about 59 bits)
    --existing-opens   only for an old two-column file (Label | Code): the Opens
                       value to give every existing row, e.g. 'all'

A one-time backup of the original file is written next to it as
<name>.bak-<timestamp> before the first change.
"""

import argparse
import datetime
import os
import secrets
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import build_chickenwhispering_multi as multi   # noqa: E402

# Unambiguous symbols: no I, L, O, U (look like 1/0/V) and no 0 or 1.
ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
HEADERS = ("Label", "Code", "Opens")


def read_raw_rows(path, existing_opens):
    """Rows as written: [(label, code_as_written, opens_text)], plus the header's
    first-column title ('Label' if there is no header) and the file's newline.
    Never echoes codes."""
    text = path.read_text(encoding="utf-8")
    rows, first_header = [], "Label"
    for n, line in enumerate(text.splitlines(), 1):
        cells = multi.table_cells(line)
        if not cells:
            continue
        if multi.is_header(cells):
            first_header = cells[0] or first_header
            continue
        if len(cells) == 3:
            rows.append(tuple(cells))
        elif len(cells) == 2:
            if not existing_opens:
                raise ValueError(f"line {n} has no Opens column; pass --existing-opens "
                                 "(e.g. 'all') to fill it for the existing rows")
            rows.append((cells[0], cells[1], existing_opens))
        else:
            raise ValueError(f"line {n}: expected 2 or 3 columns, found {len(cells)}")
    if not rows:
        raise ValueError(f"no code rows found in {path}")
    return rows, first_header, ("\r\n" if "\r\n" in text else "\n")


def render_table(rows, first_header="Label"):
    headers = (first_header,) + HEADERS[1:]
    widths = [max(len(h), *(len(r[i]) for r in rows)) for i, h in enumerate(headers)]

    def row_line(cells, header=False):
        parts = []
        for i, (c, w) in enumerate(zip(cells, widths)):
            parts.append(" " + (c.center(w) if header and i == 1 else c.ljust(w)) + " ")
        return "  " + multi.BOX_V + multi.BOX_V.join(parts) + multi.BOX_V

    def rule(left, mid, right):
        return "  " + left + mid.join("─" * (w + 2) for w in widths) + right

    lines = [rule("┌", "┬", "┐"), row_line(headers, header=True)]
    for r in rows:
        lines.append(rule("├", "┼", "┤"))
        lines.append(row_line(r))
    lines.append(rule("└", "┴", "┘"))
    return lines


def generate_code(length, taken):
    for _ in range(100):
        code = "".join(secrets.choice(ALPHABET) for _ in range(length))
        if multi.brg.normalize_code(code) not in taken:
            return code
    raise RuntimeError("could not generate a unique code")


def main(argv):
    ap = argparse.ArgumentParser(description="Add a generated access code to the codes file.")
    ap.add_argument("--codes-file", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--opens", required=True)
    ap.add_argument("--length", type=int, default=12)
    ap.add_argument("--existing-opens", default=None)
    args = ap.parse_args(argv)

    try:
        catalog = multi.validate_catalog()
        path = Path(args.codes_file)
        if not path.is_file():
            raise FileNotFoundError(f"codes file not found: {path}")
        if not multi.LABEL_RE.match(args.label):
            raise ValueError(f"label must match {multi.LABEL_RE.pattern}")
        if not 10 <= args.length <= 64:
            raise ValueError("--length must be between 10 and 64")
        multi.parse_opens(args.opens, args.label, catalog)            # validates keys
        if args.existing_opens:
            multi.parse_opens(args.existing_opens, "(existing rows)", catalog)

        rows, first_header, newline = read_raw_rows(path, args.existing_opens)
        if any(r[0] == args.label for r in rows):
            raise ValueError(f"label '{args.label}' already exists")
        # Validate the existing rows exactly as the builder will.
        before = [(r[0], multi.brg.normalize_code(r[1]), r[2]) for r in rows]
        taken = {c for _, c, _ in before}

        new_code = generate_code(args.length, taken)
        new_rows = rows + [(args.label, new_code, args.opens.strip())]
        text = newline.join(render_table(new_rows, first_header)) + newline

        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8", newline="")
        parsed = multi.read_codes_file(tmp, catalog)                 # full builder validation
        expected = [(lbl, multi.brg.normalize_code(c), multi.parse_opens(o, lbl, catalog))
                    for lbl, c, o in new_rows]
        got = [(r["label"], r["code"], r["opens"]) for r in parsed]
        if got != expected:
            tmp.unlink()
            raise RuntimeError("re-read of the new table does not match; original left untouched")

        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = path.with_name(f"{path.name}.bak-{stamp}")
        backup.write_bytes(path.read_bytes())
        os.replace(tmp, path)
    except (ValueError, FileNotFoundError, RuntimeError) as exc:
        print(f"Error: {exc}")
        return 1

    print(f"Added '{args.label}' (opens: {args.opens.strip()}), {args.length} characters.")
    print(f"Backup of the previous file: {backup.name}")
    print("Rows now (labels only):")
    for lbl, _, o in new_rows:
        print(f"  {lbl}: {o}")
    print(f"Read the new code in {path} -- it is not printed here.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
