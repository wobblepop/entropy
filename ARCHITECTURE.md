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
- `js/markdown.js` — lightweight markdown-to-HTML parser
- `js/state.js` — centralized state with event bus
- `js/navigation.js` — sidebar tree and breadcrumbs
- `js/renderer.js` — content rendering engine
- `js/themes.js` — theme switching UI and persistence
- `js/accessibility.js` — keyboard shortcuts, font/spacing controls, ARIA announcements
- `js/media.js` — multimedia rendering (image, video, audio, embed, diagram)
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
- `js/state.js` — editor state with dirty tracking
- `js/tree.js` — left panel node tree
- `js/editor.js` — center panel node editing
- `js/palette.js` — Ctrl+K command palette
- `js/graph.js` — canvas-based relationship visualizer
- `js/app.js` — entry point, keyboard shortcuts, file I/O

**Features:**
- Three-panel layout with resizable dividers
- Command palette (Ctrl+K) for all actions
- Rich text WYSIWYG editing (contenteditable with markdown I/O)
- Code block support (fenced triple-backtick round-trips cleanly)
- Auto-saving to state on keystroke (400ms debounce)
- Undo/redo (Ctrl+Z — 30-state deep snapshot stack)
- Inline link insertion form (URL + text fields)
- Markdown toolbar with keyboard shortcuts
- Tag management (enter to add, backspace/click to remove)
- Children/connections/media management with inline forms (toggle, Enter-to-submit)
- Quick-create child node button
- Node duplication
- Word count (per-node and total)
- Node relationship graph visualization (interactive: click-to-select, hover, arrows, color-coded)
- Book metadata editing in right panel
- Live markdown preview
- Preview in new tab (self-contained HTML)
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

## Hosting

Both tools are static HTML/CSS/JS — no build step, no server needed.
- Local: double-click index.html
- GitHub Pages: push the folder
- Any CDN/static host: upload as-is

## Extending

To add a new theme: add CSS variables in `explainer/css/themes.css`, add to the themeMap in `explainer/js/themes.js`.
To add a new node field: update schema.json, add to editor form in editor.js, render in explainer renderer.js.
To add a new connection type: add to schema enum, add CSS class in components.css, it auto-renders.
