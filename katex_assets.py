#!/usr/bin/env python3
"""KaTeX assets for the exporters and the single-file builds.

The vendored KaTeX (shared/vendor/katex, MIT, version in its README) renders LaTeX
equations. Three uses:

* katex_css_inlined() / katex_js(): the stylesheet with its woff2 fonts embedded as
  data: URIs and the script, for pages that must stand alone (editor.html, the viewer
  template, the standalone HTML export, the PDF pass pages).
* katex_bundle_html(): the two plus a small renderer that turns every
  <span class="math" data-tex="..."> / <div class="math math-display" ...> the Python
  markdown renderer emits into KaTeX output when the page loads (so the TeX source is
  what the file carries, and what shows if scripts cannot run).
* render_mathml(): TeX -> MathML through Node.js and the same KaTeX build, for EPUB,
  where no script runs. Node is required for that path and its absence is an error,
  never a silent fallback.
"""
import base64
import json
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
KATEX_DIR = HERE / "shared" / "vendor" / "katex"
MATHML_SCRIPT = HERE / "shared" / "katex_mathml.js"

_FONT_SRC = re.compile(
    r'url\(fonts/([A-Za-z0-9_-]+\.woff2)\) format\("woff2"\),'
    r'url\(fonts/[A-Za-z0-9_-]+\.woff\) format\("woff"\),'
    r'url\(fonts/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)'
)
_cache = {}


def _require(path, what):
    if not path.is_file():
        raise FileNotFoundError(f"{what} is missing: {path}")
    return path


def katex_css_inlined():
    """katex.min.css with every woff2 font embedded as a data: URI (the woff/ttf fallbacks
    are dropped). Raises if the stylesheet or a font file is missing."""
    if "css" in _cache:
        return _cache["css"]
    css = _require(KATEX_DIR / "katex.min.css", "KaTeX stylesheet").read_text(encoding="utf-8")

    def repl(m):
        font = _require(KATEX_DIR / "fonts" / m.group(1), "KaTeX font")
        b64 = base64.b64encode(font.read_bytes()).decode("ascii")
        return f'url(data:font/woff2;base64,{b64}) format("woff2")'

    css, n = _FONT_SRC.subn(repl, css)
    if n == 0 or "url(fonts/" in css:
        raise ValueError("KaTeX stylesheet font references were not inlined as expected")
    _cache["css"] = css
    return css


def katex_js():
    """katex.min.js as text (source-map pointer dropped so browsers do not look for it)."""
    if "js" in _cache:
        return _cache["js"]
    js = _require(KATEX_DIR / "katex.min.js", "KaTeX script").read_text(encoding="utf-8")
    js = re.sub(r"^//# sourceMappingURL=.*$", "", js, flags=re.M).rstrip() + "\n"
    _cache["js"] = js
    return js


RENDER_JS = """(function () {
  if (typeof katex === 'undefined' || !katex.render) return;
  var els = document.querySelectorAll('.math[data-tex]');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    try {
      katex.render(el.getAttribute('data-tex'), el, {
        displayMode: el.classList.contains('math-display'), throwOnError: false, trust: false });
    } catch (e) { /* leave the TeX source visible */ }
  }
})();"""


def katex_bundle_html():
    """<style> + <script> blocks to append before </body> of a page carrying .math elements."""
    return ("<style>" + katex_css_inlined() + "</style>\n"
            "<script>" + katex_js().replace("</script>", "<\\/script>") + "</script>\n"
            "<script>" + RENDER_JS + "</script>")


def render_mathml(items):
    """items: list of (tex, display) -> list of {"mathml": str or None, "error": str or None},
    one per item, in order. Uses Node.js and the vendored KaTeX; raises RuntimeError when
    Node or the script is unavailable or the conversion fails as a whole."""
    items = list(items)
    if not items:
        return []
    for tex, display in items:
        if not isinstance(tex, str):
            raise TypeError("render_mathml: each item is (tex: str, display: bool)")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Converting equations to MathML (EPUB) needs Node.js, and `node` was not "
                           "found on PATH. Install Node.js, or remove the equations before exporting.")
    _require(MATHML_SCRIPT, "KaTeX MathML helper")
    _require(KATEX_DIR / "katex.min.js", "KaTeX script")
    payload = json.dumps([[tex, bool(display)] for tex, display in items])
    proc = subprocess.run([node, str(MATHML_SCRIPT)], input=payload, capture_output=True,
                          text=True, encoding="utf-8", cwd=str(HERE))
    if proc.returncode != 0:
        raise RuntimeError("KaTeX MathML conversion failed: " + (proc.stderr.strip() or f"exit {proc.returncode}"))
    try:
        out = json.loads(proc.stdout)
    except ValueError as exc:
        raise RuntimeError(f"KaTeX MathML helper returned invalid JSON: {exc}") from exc
    if not isinstance(out, list) or len(out) != len(items):
        raise RuntimeError("KaTeX MathML helper returned the wrong number of results")
    return out
