#!/usr/bin/env python3
"""Tests that the Python exporters honour the same whitelisted inline <span style> as the
editor (text colour, highlight, relative font size, font family) and reject the same
unsafe values, so a font attached in the editor reaches the HTML, PDF and EPUB output and
nothing else does. The EPUB exporter reuses entropy_to_html.markdown_to_html, so the two
modules tested here cover all three exports.

Run:  py test_inline_style.py
"""
import sys

import entropy_to_html
import entropy_to_pdf_v2

BASE = "."

# (markdown, must_contain[list], must_not_contain[list])
INLINE_CASES = [
    ('a <span style="font-family: Algerian">x</span> b',
     ['<span style="font-family: Algerian">x</span>'], ["&lt;span"]),
    ('a <span style="font-family: Times New Roman, serif">x</span> b',
     ['<span style="font-family: Times New Roman, serif">x</span>'], ["&lt;span"]),
    ('a <span style="color: #d64545; font-family: Garamond">x</span> b',
     ['<span style="color: #d64545; font-family: Garamond">x</span>'], ["&lt;span"]),
    ('a <span style="font-family: Algerian">**bold**</span> b',
     ['<span style="font-family: Algerian"><strong>bold</strong></span>'], []),
    # the pre-existing properties still work alongside
    ('a <span style="font-size: larger">x</span> b', ['<span style="font-size: larger">x</span>'], []),
    # rejected values: the span stays escaped literal text, nothing is injected
    ('a <span style="font-family: url(x)">x</span> b', ["&lt;span"], ["<span style"]),
    ('a <span style="font-family: 1abc">x</span> b', ["&lt;span"], ["<span style"]),
    ('a <span style="font-family: Algerian, ">x</span> b', ["&lt;span"], ["<span style"]),
    ('a <span style="font-family: Alg$rian">x</span> b', ["&lt;span"], ["<span style"]),
    ('a <span style="behavior: url(x)">x</span> b', ["&lt;span"], ["<span style"]),
]

# (style attribute text, canonical result) -- must match the editor's sanitizeInlineStyle
SANITIZE_CASES = [
    ("font-family: Algerian", "font-family: Algerian"),
    ('font-family: "Times New Roman"', "font-family: Times New Roman"),
    ("font-family: 'Segoe Print', cursive", "font-family: Segoe Print, cursive"),
    ("font-family:   Book   Antiqua ", "font-family: Book Antiqua"),
    ("font-family: Algerian; color: #d64545", "font-family: Algerian; color: #d64545"),
    ("FONT-FAMILY: Algerian", "font-family: Algerian"),
    ("font-family: url(x)", ""),
    ("font-family: expression(alert(1))", ""),
    ('font-family: Algerian, "', ""),
    ("font-family: " + "a" * 70, ""),
    ("font-family: 1abc", ""),
    ("font-family: Alg$rian", ""),
    ("font-family: Algerian; behavior: url(x)", "font-family: Algerian"),
    ("", ""),
    (None, ""),
]

MODULES = [
    ("entropy_to_html", entropy_to_html),
    ("entropy_to_pdf_v2", entropy_to_pdf_v2),
]


def run():
    failures = 0
    total = 0
    for mod_name, mod in MODULES:
        for md, must, must_not in INLINE_CASES:
            total += 1
            try:
                out = mod._inline(md, BASE)
            except Exception as exc:  # a regex/runtime error is a hard failure
                print(f"FAIL [{mod_name}] {md!r}: raised {exc!r}")
                failures += 1
                continue
            bad = [s for s in must if s not in out] + [s for s in must_not if s in out]
            if bad:
                print(f"FAIL [{mod_name}] {md!r} -> {out!r}")
                print(f"     unmet: {bad}")
                failures += 1
            else:
                print(f"ok   [{mod_name}] {md!r}")
        for style, want in SANITIZE_CASES:
            total += 1
            try:
                got = mod._sanitize_style(style)
            except Exception as exc:
                print(f"FAIL [{mod_name}] _sanitize_style({style!r}) raised {exc!r}")
                failures += 1
                continue
            if got != want:
                print(f"FAIL [{mod_name}] _sanitize_style({style!r}) -> {got!r}, want {want!r}")
                failures += 1
            else:
                print(f"ok   [{mod_name}] _sanitize_style({style!r})")
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
