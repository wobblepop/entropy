#!/usr/bin/env python3
"""Tests for fix_crossline_emphasis.repair_content: cross-line marker pairs are rewritten
per line; everything else (literal asterisks, unmatched markers, code, quotes) is left
exactly as it was.

Run:  py test_crossline_fix.py
"""
import sys

from fix_crossline_emphasis import repair_content

# (content, expected content, expected number of rewritten paragraphs, expected unclear)
CASES = [
    ("*line one\nline two* tail", "*line one*\n*line two* tail", 1, 0),
    ("**a\nb**", "**a**\n**b**", 1, 0),
    ("x ~~a\nb~~ y", "x ~~a~~\n~~b~~ y", 1, 0),
    ("`x\ny`", "`x`\n`y`", 1, 0),
    ("***a\nb***", "***a***\n***b***", 1, 0),
    # nested: both markers close at the line end and reopen on the next line (the
    # parsers read "**x *y***" as bold containing italic after DOM repair, as today)
    ("**bold *and it\nalic* done**", "**bold *and it***\n***alic* done**", 1, 0),
    ("*a\nb\nc*", "*a*\n*b*\n*c*", 1, 0),
    ("> *q one\n> q two*", "> *q one*\n> *q two*", 1, 0),
    # already per-line, literal and space-flanked asterisks: untouched
    ("*a*\n*b*", "*a*\n*b*", 0, 0),
    ("3 * 4 * 5\nnext line", "3 * 4 * 5\nnext line", 0, 0),
    ("*a*\n\nnew para *b*", "*a*\n\nnew para *b*", 0, 0),
    # never closed: unclear, untouched
    ("*open\nstill open", "*open\nstill open", 0, 1),
    # code fences are skipped entirely
    ("```\n*a\nb*\n```", "```\n*a\nb*\n```", 0, 0),
    # emphasis markers inside inline code are literal
    ("`*a`\nb*", "`*a`\nb*", 0, 0),
    # headings / lists / footnote defs are not paragraph lines
    ("## *t\n- *x\ny*", "## *t\n- *x\ny*", 0, 0),
    ("[^1]: *note\nbody*", "[^1]: *note\nbody*", 0, 0),
    # a paragraph after a leak is untouched
    ("*a\nb*\n\nplain", "*a*\n*b*\n\nplain", 1, 0),
]


def run():
    failures = 0
    for content, want, n_fixed, n_unclear in CASES:
        got, reports = repair_content(content)
        fixed = sum(1 for _, a in reports if a is not None)
        unclear = sum(1 for _, a in reports if a is None)
        if got != want or fixed != n_fixed or unclear != n_unclear:
            failures += 1
            print(f"FAIL {content!r}\n     got {got!r} fixed={fixed} unclear={unclear}\n     want {want!r} fixed={n_fixed} unclear={n_unclear}")
        else:
            print(f"ok   {content!r}")
    print(f"\n{len(CASES) - failures}/{len(CASES)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
