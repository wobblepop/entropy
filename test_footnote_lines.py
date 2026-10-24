#!/usr/bin/env python3
"""Tests that the Python exporters keep multi-line footnote text inside the note, matching
the editor's serializer (continuation lines indented by four spaces or a tab) and the
reader. A newline inside a note must never leak into the body.

Run:  py test_footnote_lines.py
"""
import sys

import entropy_to_html
import entropy_to_pdf_v2

MODULES = [("entropy_to_html", entropy_to_html), ("entropy_to_pdf_v2", entropy_to_pdf_v2)]

CASES = [
    # (markdown, expected defs, expected body)
    ("Claim.[^1]\n\n[^1]: first line\n    second line", {"1": "first line\nsecond line"}, "Claim.[^1]\n"),
    ("Claim.[^1]\n\n[^1]: a\n    b\n\n    after blank", {"1": "a\nb\n\nafter blank"}, "Claim.[^1]\n"),
    ("x[^1]\n\n[^1]: a\n\tb\nnot part", {"1": "a\nb"}, "x[^1]\n\nnot part"),
    ("x[^1]\n\n[^1]: only", {"1": "only"}, "x[^1]\n"),
    ("x[^1]\n\n[^1]: a\n\nplain paragraph", {"1": "a"}, "x[^1]\n\n\nplain paragraph"),
]


def run():
    failures = 0
    total = 0
    for name, mod in MODULES:
        for md, want_defs, want_body in CASES:
            total += 1
            body, defs = mod._harvest_footnote_defs(md)
            if defs != want_defs or body != want_body:
                print(f"FAIL [{name}] {md!r}\n     defs {defs!r} body {body!r}")
                failures += 1
            else:
                print(f"ok   [{name}] {md!r}")
        total += 1
        html = mod.markdown_to_html("Claim.[^1]\n\n[^1]: first line\n    second line", ".", fn_prefix="n")
        if 'fn-note-text">first line<br>second line<' in html and "<p>second line" not in html:
            print(f"ok   [{name}] note renders both lines, nothing leaks")
        else:
            print(f"FAIL [{name}] rendered: {html!r}")
            failures += 1
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
