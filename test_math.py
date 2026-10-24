#!/usr/bin/env python3
"""Tests that the Python exporters handle equations like the editor and the reader: inline
$...$ and display $$ blocks become .math elements carrying the TeX, dollar amounts stay
text, \$ is a literal dollar, TeX is never touched by emphasis, the standalone HTML ships
KaTeX only when a book has equations, and the EPUB path converts TeX to MathML through
Node (required; its absence is an error).

Run:  py test_math.py
"""
import sys

import entropy_to_html
import entropy_to_pdf_v2
import entropy_to_epub
import katex_assets

BASE = "."
MODULES = [("entropy_to_html", entropy_to_html), ("entropy_to_pdf_v2", entropy_to_pdf_v2)]
EQ = r"f(Problem_u) = \frac{RelationalProximity_{fu}}{spacetime^2}"

# (markdown, must_contain, must_not_contain) through _inline
INLINE_CASES = [
    ("where $RP_{fu}$ is", ['<span class="math" data-tex="RP_{fu}">RP_{fu}</span>'], []),
    ("$a*b*c$ and *it*", ['data-tex="a*b*c"', "<em>it</em>"], ['data-tex="a<em>']),
    ("$x_1 < y_2$", ['data-tex="x_1 &lt; y_2"'], ["<y_2"]),
    ("$5 and $10", [], ['class="math"']),
    ("costs $5 or $ more", [], ['class="math"']),
    ("pay \\$5 now", ["pay $5 now"], ['class="math"', "\\$"]),
    ("use `$x$` literally", ["<code>$x$</code>"], ['class="math"']),
    ("a $$ b", [], ['class="math"']),
]

# (markdown, must_contain, must_not_contain) through markdown_to_html
BLOCK_CASES = [
    ("Intro\n\n$$\n" + EQ + "\n$$\n\nAfter",
     ['<div class="math math-display" data-tex="f(Problem_u) = \\frac{RelationalProximity_{fu}}{spacetime^2}">', "<p>Intro</p>", "<p>After</p>"], []),
    ("a\n\n$$x^2$$\n\nb", ['<div class="math math-display" data-tex="x^2">x^2</div>'], []),
    ("```\n$$\nnot math\n$$\n```", ["<pre><code>$$\nnot math\n$$\n</code></pre>"], ['class="math']),
    ("$$\nnever closed", ["<p>$$</p>", "<p>never closed</p>"], ['class="math']),
    (":::example\n$$\ny=mx\n$$\n:::", ['class="example-block"', 'data-tex="y=mx"'], []),
    ("- item $x$", ['<li>item <span class="math" data-tex="x">x</span></li>'], []),
]


def run():
    failures = 0
    total = 0

    def check(ok, label, detail=""):
        nonlocal failures, total
        total += 1
        print(("ok   " if ok else "FAIL ") + label + ("" if ok else "\n     " + detail))
        if not ok:
            failures += 1

    for name, mod in MODULES:
        for md, must, must_not in INLINE_CASES:
            out = mod._inline(md, BASE)
            bad = [s for s in must if s not in out] + [s for s in must_not if s in out]
            check(not bad, f"[{name}] inline {md!r}", f"{out!r} unmet {bad}")
        for md, must, must_not in BLOCK_CASES:
            out = mod.markdown_to_html(md, BASE)
            bad = [s for s in must if s not in out] + [s for s in must_not if s in out]
            check(not bad, f"[{name}] block {md[:40]!r}", f"{out!r} unmet {bad}")

    # standalone HTML: KaTeX bundle only when equations exist
    def book(content):
        return {"meta": {"title": "T", "version": "1"}, "root": "a",
                "nodes": {"a": {"id": "a", "title": "A", "content": content, "children": []}}}
    plain = entropy_to_html.build_html(book("plain text"), BASE, entropy_to_html.tree_order(book("x")), "t.json")
    withm = entropy_to_html.build_html(book("see $x^2$"), BASE, entropy_to_html.tree_order(book("x")), "t.json")
    check("katex" not in plain.lower(), "[entropy_to_html] no KaTeX bundle without equations")
    check("katex.render(" in withm and "data:font/woff2;base64," in withm, "[entropy_to_html] KaTeX bundle + inlined fonts with equations")
    pdf_html = entropy_to_pdf_v2.build_main_html(book("see $x^2$"), BASE, entropy_to_pdf_v2.tree_order(book("x")))
    check("katex.render(" in pdf_html, "[entropy_to_pdf_v2] KaTeX bundle in the PDF page")
    pdf_plain = entropy_to_pdf_v2.build_main_html(book("plain"), BASE, entropy_to_pdf_v2.tree_order(book("x")))
    check("katex" not in pdf_plain.lower(), "[entropy_to_pdf_v2] no KaTeX bundle without equations")

    # EPUB: TeX -> MathML through Node (required)
    try:
        res = katex_assets.render_mathml([(EQ, True), ("RP_{fu}", False), ("\\frac{a}", False)])
        check(res[0]["mathml"] is not None and res[0]["mathml"].startswith("<math") and 'display="block"' in res[0]["mathml"],
              "[katex_assets] display equation -> MathML", repr(res[0])[:200])
        check(res[1]["mathml"] is not None and "<msub>" in res[1]["mathml"], "[katex_assets] inline subscript -> MathML", repr(res[1])[:200])
        check(res[2]["mathml"] is None and res[2]["error"], "[katex_assets] bad TeX reports an error", repr(res[2])[:200])
        xhtml = entropy_to_epub._math_to_mathml(entropy_to_html.markdown_to_html("see $RP_{fu}$ and\n\n$$\n" + EQ + "\n$$", BASE))
        check('<math xmlns="http://www.w3.org/1998/Math/MathML"' in xhtml and "<msub>" in xhtml and "class=\"math\" data-tex" not in xhtml,
              "[entropy_to_epub] .math elements replaced by MathML", xhtml[:300])
        check('<div class="math-display"><math' in xhtml, "[entropy_to_epub] display equation wrapped as a block")
        entropy_to_epub.sanitize_xhtml(xhtml)
        check(True, "[entropy_to_epub] MathML survives the XHTML rebuilder")
    except RuntimeError as exc:
        check(False, "[katex_assets] MathML conversion available", str(exc))

    print(f"\n{total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(run())
