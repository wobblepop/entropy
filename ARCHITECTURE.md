# Entropy — Architecture Overview

Two tools, one content format.

## Content Format (.entropy.json)

A single JSON file defines an entire textbook:
- `meta` — title, author, version, timestamps
- `root` — the entry node ID
- `nodes` — all content nodes (keyed by ID)
- `themes` — available themes for Explainer

Each node has: id, title, summary, content (markdown), children (ordered), connections (typed links), media, tags, difficulty, estimatedTime.

Schema: `shared/schema.json`

## EntropyExplainer (Reader)

`explainer/index.html` — open directly in a browser or host on any static server.

**Files:**
- `css/base.css` — layout, typography, core components
- `css/themes.css` — four theme color palettes (clean, academic, dark, high-contrast)
- `css/components.css` — animations, cards, badges, media, toasts
- `css/accessibility.css` — focus states, reduced motion, print, forced colors
- `css/responsive.css` — mobile/tablet/desktop breakpoints
- `css/pdf-export.css` — "Save as PDF" picker modal + the print rules that isolate one section
- `js/markdown.js` — lightweight markdown-to-HTML parser
- `js/state.js` — centralized state with event bus
- `js/navigation.js` — sidebar tree and breadcrumbs
- `js/renderer.js` — content rendering engine
- `js/themes.js` — theme switching UI and persistence
- `js/accessibility.js` — keyboard shortcuts, font/spacing controls, ARIA announcements
- `js/media.js` — multimedia rendering (image, video, audio, embed, diagram)
- `js/print-chapter.js` — "Save as PDF": picker modal, print-only render of a section (+ sub-sections), `window.print()` with the document retitled so the suggested file name is `<book> - <chapter>`; `#pdf=<nodeId>` deep link. Also `PrintChapter.printSections(ids, { withChildren })` (reachable cross-frame as `window.PrintChapter`): prints any list of sections in reading order, retitled `<book> - <first> to <last>`; the editor's picker drives this. Output: a Contents page (when more than one section prints) and then one section per page, contents entries linked to section anchors
- `js/app.js` — entry point, file loading, drag-drop, glue

**Features:**
- Choose-your-own-adventure navigation via child cards and connection links
- Linear next/previous navigation buttons following tree order
- Four themes with localStorage persistence
- Reading progress tracking per book (visited indicators in sidebar)
- Reading position persistence (resume where you left off on reload)
- Adjustable font size, line height, content width
- Full keyboard navigation (Alt+Left = back, / = search, Ctrl+/ = sidebar)
- Screen reader friendly (ARIA live regions, roles, skip links)
- Reduced motion support
- Print styles
- Save any section (chapter) plus its sub-sections as a PDF through the browser's print dialog; chapters are labelled from `meta.structure` when present. Plain Ctrl+P is unchanged. `printSections()` prints several sections at once (used by the editor; the viewer's own picker stays single-choice). Each printed section starts on a new page, after a Contents page whenever more than one prints.
- High contrast / forced colors support
- Mobile responsive (touch targets, collapsed sidebar)
- Drag-and-drop file loading
- Modal backdrop click-to-close

## EntropyEditor (Authoring)

`editor/index.html` — open directly in a browser.

**Files:**
- `css/base.css` — dark theme, scrollbars, toasts, modals
- `css/panels.css` — three-panel layout, tree, tabs
- `css/editor.css` — node editor, toolbar, tags, palette
- `css/pdf-export.css` — "Generate PDF" section picker + service-status line
- `js/state.js` — editor state with dirty tracking
- `js/tree.js` — left panel node tree
- `js/editor.js` — center panel node editing
- `js/pdf-export.js` — "Generate PDF": checkbox picker of every section (ticking one ticks its sub-sections; any tick, the heading included, can be removed); POSTs the book snapshot + ticked ids to the local PDF service and saves the returned PDF (save picker, or a download) as `<book> - <selection>.pdf`; checks `GET /health` when opened and says how to start the service when it is down
- `js/palette.js` — Ctrl+K command palette
- `js/graph.js` — canvas-based relationship visualizer
- `js/app.js` — entry point, keyboard shortcuts, file I/O

**Features:**
- Three-panel layout with resizable dividers
- Command palette (Ctrl+K) for all actions
- Rich text WYSIWYG editing (contenteditable with markdown I/O). The serializer never lets an emphasis or code marker span a soft line break (each line is wrapped on its own, so `*a*\n*b*` rather than `*a\nb*`, which every line-based parser would read as literal asterisks); `fix_crossline_emphasis.py <book.json>` reports, and with `--apply` repairs, files saved before that rule existed
- Equations: LaTeX, inline as `$...$` (the opener is not followed by a space or another `$`, the closer is not preceded by a space and not followed by a digit, so `$5 and $10` stays text; `\$` is a literal dollar; inline code is never scanned) and display as a `$$` line, TeX lines, a `$$` line (or one line `$$...$$`). Insert with the toolbar `∑` button, `Ctrl+Shift+E`, or the palette; the pop-up shows a live KaTeX preview and the parser's message, and "Convert to text" turns an equation back into literal `$...$`. Text typed as `$x$` stays text (serialized as `\$x\$`); select it and press `∑` to make it an equation. Rendering is KaTeX 0.19.0, vendored under `shared/vendor/katex/` (MIT; source https://github.com/KaTeX/KaTeX/releases/tag/v0.19.0) and inlined with its fonts into `editor.html`, the viewer template, the standalone HTML export and the PDF pages, so no network is needed. The EPUB has no script, so `entropy_to_epub.py` converts each equation to MathML through Node.js and the same KaTeX build (`shared/katex_mathml.js`); Node is required for an EPUB that contains equations. From Word: switch the equation to LaTeX form on the Equation tab, copy it, and paste it into the pop-up (Word's LaTeX dialect omits `\begin{}`/`\end{}`; see Microsoft's "Linear format equations using UnicodeMath and LaTeX in Word")
- Footnotes: the editing surface shows each note as a numbered pill and lists the note texts in a Footnotes block under the surface (click a pill or a list entry to edit; the list updates as pills are added, edited or deleted). The preview, reader, HTML, PDF and EPUB render the notes after the section
- Footnotes whose text spans several lines are stored as `[^id]: first line` followed by continuation lines indented by four spaces (a blank line inside the note is kept when an indented line follows); the editor, reader and the HTML/PDF/EPUB exporters all fold them back into the note and render the lines with `<br>`
- Code block support (fenced triple-backtick round-trips cleanly)
- Auto-saving to state on keystroke (400ms debounce)
- Undo/redo (Ctrl+Z — 30-state deep snapshot stack)
- Inline link insertion form (URL + text fields)
- Markdown toolbar with keyboard shortcuts
- Text formatting menu (the A± button): font size, font family, super/subscript, text colour, highlight, upside-down text, clear formatting. Font family offers a picker of common installed faces (Algerian, Old English Text MT, Garamond, ...) and a field for any other font name; the choice is stored in the markdown as a whitelisted `<span style="font-family: ...">` that the editor, reader, HTML, PDF and EPUB exporters all honour. Fonts are referenced by name, not embedded: the PDF renderer embeds whatever face is installed on the machine that runs it, while HTML/EPUB readers fall back to their default face when the named font is missing
- Tag management (enter to add, backspace/click to remove)
- Children/connections/media management with inline forms (toggle, Enter-to-submit)
- Quick-create child node button
- Node duplication
- Word count (per-node and total)
- Node relationship graph visualization (interactive: click-to-select, hover, arrows, color-coded)
- Book metadata editing in right panel
- Live markdown preview
- Preview in new tab (self-contained HTML)
- "Generate PDF" (header PDF button, palette) — tick any set of sections (ticking one ticks its sub-sections; untick any you don't want, including the heading itself) and get the exporter's real PDF: cover, contents page with true page numbers, one section per page, in reading order. Needs the local PDF service (see Exporters); no print dialog is involved, so the output is always text
- Dirty state tracking with unsaved changes warning
- Full keyboard shortcut set
- Dark mode only (reduces eye strain for long editing sessions)

## Module Independence

Each JS module follows a pattern:
1. Self-contained IIFE returning a public API
2. Communicates via the State event bus (on/emit)
3. Owns its own DOM elements and event listeners
4. No module directly imports another (except State)

This means an AI editor can modify any single file without understanding the others — just maintain the event contract.

## Event Contracts

**Explainer events:** content-loaded, navigate, theme-changed, settings-changed, sidebar-toggled  
**Editor events:** file-loaded, node-selected, node-updated, node-added, node-deleted, meta-updated, dirty-changed

**Editor State API:** getData, getNode, getSelectedNode, selectNode, addNode, deleteNode, duplicateNode, updateNode, updateMeta, setRoot, pushUndo, undo, canUndo, getWordCount, getLinearOrder, getAllNodeIds, getExportData, markDirty, markClean, isDirty, loadContent, newFile  
**Explainer State API:** loadContent, navigate, goBack, goHome, getCurrentNode, getNode, isVisited, getProgress, getLinearOrder, getNextNode, getPrevNode, setTheme, setFontSize, setLineHeight, setContentWidth, toggleSidebar

## Exporters (Python, repo root)

- `entropy_to_pdf_v2.py` — the PDF pipeline: styled HTML rendered by Playwright Chromium, two passes so the contents page carries true page numbers (PyMuPDF reads them back from the first pass via named destinations, falling back to invisible ENTRPGMK markers; the second pass, which becomes the delivered PDF, is rendered without those markers so no hidden text reaches the reader -- `--page-marks` / `render_book(page_marks=True)` keeps them for tooling that scrapes them), unnumbered cover merged in front, every chapter on its own page. `--sections id1,id2` / `--sections-file` render exactly those nodes (contents limited to them, Part dividers kept only with a surviving chapter, chapter numbers unchanged, back-matter index omitted). `render_book(data, output, sections=...)` does the same in-process.
- `pdf_service.py` — local HTTP service (127.0.0.1:8644) behind the editor's "Generate PDF" picker: `GET /health`, `POST /pdf` with `{data, sections, filename}` → `application/pdf`. Start it with `py pdf_service.py` or `start_pdf_service.bat`; `--port` and `--base-dir` (folder that relative image paths resolve against) are optional. The editor reads the URL from localStorage key `entropy-pdf-service-url` when set.
- `test_pdf_selection.py` — browser-free tests of the selection logic; `editor/test/e2e_pdf_export.py` drives the editor + service end to end.
- `entropy_to_html.py`, `entropy_to_epub.py`, `docx_to_entropy.py` — HTML / EPUB export and Word import.

## Hosting

Both tools are static HTML/CSS/JS — no build step, no server needed to read or edit.
- Local: double-click index.html
- GitHub Pages: push the folder
- Any CDN/static host: upload as-is
- Generating PDFs from the editor is the one feature that needs something running: the local PDF service above.

## Extending

To add a new theme: add CSS variables in `explainer/css/themes.css`, add to the themeMap in `explainer/js/themes.js`.
To add a new node field: update schema.json, add to editor form in editor.js, render in explainer renderer.js.
To add a new connection type: add to schema enum, add CSS class in components.css, it auto-renders.
