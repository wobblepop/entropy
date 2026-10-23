#!/usr/bin/env python3
"""Selection tests for entropy_to_pdf_v2.py (no browser needed).

Guards the section-selection path that pdf_service.py and the editor's "Generate
PDF" picker rely on: apply_selection keeps reading order and drops Part dividers
that lose all their chapters, chapter numbers stay as in the whole book, the
contents page and chapters are limited to the selection, the back-matter index is
left out of a partial export, and render_book rejects bad input before any
browser starts.

Run:  py test_pdf_selection.py        (from the repo root)
"""
import sys
import re
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entropy_to_pdf_v2 as X  # noqa: E402

PLAIN = {
    "meta": {"title": "Plain"},
    "root": "r",
    "nodes": {
        "r": {"id": "r", "title": "Root", "content": "root body", "children": ["c1", "c2", "c3"]},
        "c1": {"id": "c1", "title": "One", "content": "one body", "children": ["c1a"],
               "connections": [{"to": "c2", "type": "related", "label": "Two-ish"}]},
        "c1a": {"id": "c1a", "title": "One A", "content": "one a body", "children": []},
        "c2": {"id": "c2", "title": "Two", "content": "two body", "children": []},
        "c3": {"id": "c3", "title": "Three", "content": "three body", "children": []},
        "orphan": {"id": "orphan", "title": "Orphan", "content": "", "children": []},
    },
}

STRUCT = {
    "meta": {
        "title": "Structured",
        "structure": {
            "frontmatter": ["r"],
            "parts": [
                {"title": "Alpha", "nodes": ["c1", "c1a"]},
                {"title": "Beta", "nodes": ["c2"]},
            ],
            "epilogues": [{"title": "After", "node": "c3"}],
        },
        "index": {"entries": [
            {"term": "Widgets", "primary_nid": "c1", "chapters": [1], "primary_ch": 1, "pages": [3], "primary_page": 3},
        ]},
    },
    "root": PLAIN["root"],
    "nodes": PLAIN["nodes"],
}


class ApplySelection(unittest.TestCase):
    def test_none_means_everything(self):
        order, items, ids = X.apply_selection(PLAIN, None)
        self.assertEqual(order, X.tree_order(PLAIN))
        self.assertIsNone(items)
        self.assertEqual(ids, X.ordered_ids(PLAIN))

    def test_plain_book_keeps_reading_order(self):
        order, items, ids = X.apply_selection(PLAIN, ["c3", "c1", "orphan"])
        self.assertEqual(order, [("c1", 1), ("c3", 1), ("orphan", 0)])
        self.assertIsNone(items)
        self.assertEqual(ids, ["c1", "c3", "orphan"])

    def test_plain_book_ignores_nothing_silently(self):
        # apply_selection only filters; unknown ids are rejected earlier by validate_selection
        order, _, ids = X.apply_selection(PLAIN, ["c2"])
        self.assertEqual(order, [("c2", 1)])
        self.assertEqual(ids, ["c2"])

    def test_structured_drops_empty_parts_keeps_numbers_and_omits_index(self):
        order, items, ids = X.apply_selection(STRUCT, ["c2", "c3"])
        self.assertEqual([(it["kind"], it.get("nid"), it.get("num")) for it in items],
                         [("part", None, 2), ("chapter", "c2", 3), ("epilogue", "c3", None)])
        self.assertEqual(ids, ["part-2", "c2", "c3"])
        self.assertNotIn("book-index", ids)
        self.assertEqual(order, [("c2", 1), ("c3", 1)])

    def test_structured_whole_book_keeps_index(self):
        _, items, ids = X.apply_selection(STRUCT, None)
        self.assertEqual(ids[-1], "book-index")
        self.assertEqual([it["kind"] for it in items], ["front", "part", "chapter", "chapter", "part", "chapter", "epilogue"])

    def test_structured_selection_outside_structure_renders_nothing(self):
        _, items, ids = X.apply_selection(STRUCT, ["orphan"])
        self.assertEqual(items, [])
        self.assertEqual(ids, [])


class MainHtml(unittest.TestCase):
    def test_plain_contents_and_chapters_limited_to_selection(self):
        html = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN), page_map={"c1": 4}, selection=["c3", "c1"])
        self.assertIn('id="node-c1"', html)
        self.assertIn('id="node-c3"', html)
        self.assertNotIn('id="node-c2"', html)
        self.assertNotIn('id="node-r"', html)
        self.assertEqual(html.count('class="toc-entry'), 2)
        self.assertLess(html.index('id="node-c1"'), html.index('id="node-c3"'), "reading order")
        self.assertIn('<span class="page">4</span>', html)
        self.assertIn(f"{X.MARK_PREFIX}c1{X.MARK_PREFIX}", html)
        self.assertNotIn(f"{X.MARK_PREFIX}c2{X.MARK_PREFIX}", html)

    def test_structured_partial_keeps_chapter_numbers_and_drops_index(self):
        html = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT), selection=["c2"])
        self.assertIn("Chapter 3", html)
        self.assertIn("Part II", html)
        self.assertNotIn("Part I<", html)
        self.assertNotIn('id="book-index"', html)          # the CSS rule text is always present; the section is not
        self.assertNotIn('href="#book-index"', html)
        self.assertNotIn('id="node-c1"', html)

    def test_structured_whole_book_has_index(self):
        html = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT))
        self.assertIn('id="book-index"', html)
        self.assertIn('href="#book-index"', html)

    def test_cross_links_to_unselected_sections_become_plain_text(self):
        partial = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN), selection=["c1", "c3"])
        self.assertIn("<span>Two-ish</span>", partial)
        self.assertNotIn('href="#node-c2"', partial)
        whole = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN))
        self.assertIn('<a class="rel-link" href="#node-c2">Two-ish</a>', whole)
        both = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN), selection=["c1", "c2"])
        self.assertIn('<a class="rel-link" href="#node-c2">Two-ish</a>', both)

    def test_without_selection_behaviour_is_unchanged(self):
        a = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN))
        b = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN), selection=None)
        self.assertEqual(a, b)


    def test_marks_default_on_and_switchable_off(self):
        """The markers are a first-pass measuring aid, so build_main_html must be
        able to leave them out entirely -- that is what makes the delivered PDF
        free of hidden text."""
        on = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN))
        off = X.build_main_html(PLAIN, Path("."), X.tree_order(PLAIN), marks=False)
        self.assertIn(X.MARK_PREFIX, on)
        self.assertNotIn(X.MARK_PREFIX, off)
        # the .pagemark CSS rule stays (it is still used when page_marks is on);
        # what must disappear is every marker span.
        self.assertNotIn('<span class="pagemark">', off)

    def test_marks_off_covers_structured_books(self):
        """Part dividers and the back-matter index emit markers of their own."""
        on = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT))
        off = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT), marks=False)
        self.assertIn(X.MARK_PREFIX, on)
        self.assertNotIn(X.MARK_PREFIX, off)

    def test_marks_off_does_not_change_anything_else(self):
        """Dropping the markers must remove only the marker spans; every other
        byte of the document has to be identical, or pagination could move."""
        on = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT))
        off = X.build_main_html(STRUCT, Path("."), X.tree_order(STRUCT), marks=False)
        stripped = re.sub(r'<span class="pagemark">[^<]*</span>', "", on)
        self.assertEqual(stripped, off)

class RenderBookValidation(unittest.TestCase):
    """render_book validates before touching Playwright, so these never start a browser."""

    def test_rejects_bad_books(self):
        with self.assertRaises(ValueError):
            X.render_book("not a dict", "x.pdf")
        with self.assertRaises(ValueError):
            X.render_book({"nodes": {}}, "x.pdf")
        with self.assertRaises(ValueError):
            X.render_book({"nodes": "junk"}, "x.pdf")
        with self.assertRaises(ValueError):
            X.render_book({"meta": "junk", "nodes": PLAIN["nodes"]}, "x.pdf")

    def test_rejects_bad_selections(self):
        with self.assertRaises(ValueError):
            X.render_book(PLAIN, "x.pdf", sections=[])
        with self.assertRaises(ValueError):
            X.render_book(PLAIN, "x.pdf", sections="c1")
        with self.assertRaises(ValueError):
            X.render_book(PLAIN, "x.pdf", sections=["c1", 42])
        with self.assertRaisesRegex(ValueError, "unknown section id"):
            X.render_book(PLAIN, "x.pdf", sections=["c1", "nope"])
        with self.assertRaisesRegex(ValueError, "no section that this book renders"):
            X.render_book(STRUCT, "x.pdf", sections=["orphan"])

    def test_validate_selection(self):
        self.assertIsNone(X.validate_selection(PLAIN, None))
        self.assertEqual(X.validate_selection(PLAIN, ("c2", "c1")), ["c2", "c1"])

    def test_sections_file_formats(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "ids.txt"
            p.write_text("# picked\nc1\n\nc3\n", encoding="utf-8")
            self.assertEqual(X._read_sections_file(p), ["c1", "c3"])
            p.write_text('["c2", "c1"]', encoding="utf-8")
            self.assertEqual(X._read_sections_file(p), ["c2", "c1"])
            p.write_text('[1, 2]', encoding="utf-8")
            with self.assertRaises(ValueError):
                X._read_sections_file(p)


if __name__ == "__main__":
    unittest.main(verbosity=1)
