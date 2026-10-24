# EntropyEditor tests

Regression tests for the editor's markdown ⇄ HTML conversion, per-node timestamps, the
reader's markdown and "Save as PDF" helpers, and the editor's PDF picker. They load the
**real** modules (not copies) so they exercise the shipping code.

## Run

```
cd "editor/test"
npm install      # installs jsdom (the only dependency)
npm test         # runs every *.test.js with Node's built-in test runner
```

Requires Node 18+ (uses `node:test`). If `jsdom` is not installed, the conversion tests
skip with a message instead of failing; the timestamp tests need no DOM and always run.

## What's covered

- `convert.test.js` — emphasis **flanking** (`3 * 4 * 5` stays literal; `**bold**` works),
  empty-tag cleanup (no `****` leakage), block-nesting backstops (no `> ## x`), span-style
  emphasis, font-family spans (canonical form, unsafe values dropped), flat + nested lists,
  link/footnote/code/table/blockquote round-trips, emphasis that spans a soft line break
  (wrapped per line, never `*a\nb*`), multi-line footnote text (indented continuation
  lines), and a
  **corpus idempotency** check: every node in any book JSON present at the repo root must
  reach a fixed point and never gain asterisks on a save.
- `timestamps.test.js` — `created`/`modified` are set on create/duplicate, `modified` is
  bumped on edit while `created` is preserved, legacy nodes degrade gracefully, and reads
  never mutate timestamps.
- `reader.test.js` — the reader's `parseInline` shares the editor's emphasis dialect and
  passes the editor's whitelisted font-family spans through intact.
- `print-chapter.test.js` — the reader's "Save as PDF" helpers (`explainer/js/print-chapter.js`):
  subtree/reading order, `meta.structure` chapter labels, suggested file names (single
  section, first-to-last range, whole book), the `#pdf` deep link, print rendering, and
  the multi-section `expandSelection` / `pdfTitleForSelection` behind `printSections()`.
- `pdf-export.test.js` — the editor's picker (`editor/js/pdf-export.js`): its copies of the
  section walks and file-name rules must match the reader's on synthetic books, junk input,
  and every book in the repo; service error messages; summary line.

## Browser check

`e2e_pdf_export.py` starts the real local PDF service on a test port, drives the built
`editor.html` in headless Chromium (Playwright), ticks sections (cascade, untick a
sub-section, untick a heading), clicks Generate PDF, and checks the downloaded file with
pypdf: text pages with embedded fonts, a cover, a contents page whose page numbers match
where every ticked section starts, one section per page, no unticked section anywhere.
It also checks the service's error responses and the picker's behaviour when the service
is not running.

```
py build_editor.py                 # editor.html must embed the current viewer
py editor/test/e2e_pdf_export.py   # from the repo root
```

Needs `playwright` (with `py -m playwright install chromium`) and `pypdf`.

## Related

`../../test_inline_flanking.py` checks that the Python exporters
(`entropy_to_html.py`, `entropy_to_pdf_v2.py`) apply the same flanking rule, so the editor,
reader, and exports agree. Run it with `py test_inline_flanking.py` from the repo root.
`../../test_inline_style.py` does the same for the whitelisted inline `<span style>`
(colour, highlight, size, font family): the exporters must keep exactly what the editor
keeps and drop exactly what it drops. Run it with `py test_inline_style.py`.
`../../test_footnote_lines.py` checks that both exporters fold indented continuation
lines back into a footnote and render them with `<br>` (`py test_footnote_lines.py`), and
`../../test_crossline_fix.py` covers the `fix_crossline_emphasis.py` repair tool
(`py test_crossline_fix.py`).
