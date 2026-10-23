#!/usr/bin/env python3
"""Tests that the Python exporters apply the same emphasis-flanking rule as the editor and
the reader (explainer/js/markdown.js), so editor/reader/PDF/EPUB/HTML all render the same
markdown identically.

Run:  py test_inline_flanking.py
"""
import sys

import entropy_to_html
import entropy_to_pdf_v2

BASE = "."

# (markdown, must_contain[list], must_not_contain[list])
CASES = [
    # space-flanked asterisks/tildes stay literal (the corruption / spurious-italics class)
    ("a 3 * 4 * 5 b", [], ["<em>", "<strong>"]),
    ("pros * cons * costs", [], ["<em>", "<strong>"]),
    ("a ~~ no ~~ b", [], ["<del>"]),
    # tight emphasis still renders
    ("a **bold** b", ["<strong>bold</strong>"], []),
    ("a *italic* b", ["<em>italic</em>"], []),
    ("a ***both*** b", ["<strong><em>both</em></strong>"], []),
    ("a ~~strike~~ b", ["<del>strike</del>"], []),
    # two separate italics, not one span across the gap
    ("x *a* *b* y", ["<em>a</em>", "<em>b</em>"], []),
    # underline: <u> survives escaping and renders as a real tag (no literal &lt;u&gt;)
    ("a <u>under</u> b", ["<u>under</u>"], ["&lt;u&gt;"]),
]

MODULES = [
    ("entropy_to_html", entropy_to_html._inline),
    ("entropy_to_pdf_v2", entropy_to_pdf_v2._inline),
]


def run():
    failures = 0
    total = 0
    for mod_name, inline in MODULES:
        for md, must, must_not in CASES:
            total += 1
            try:
                out = inline(md, BASE)
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
    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
