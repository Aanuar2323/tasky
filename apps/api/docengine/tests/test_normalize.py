import datetime as dt
import json
import subprocess
import sys
import unittest

from tests import helpers  # noqa: F401  (ajusta sys.path)
from normalize import coerce_cell, format_validation_error, normalize_payload


class TestXlsxTotals(unittest.TestCase):
    def test_model_total_row_is_dropped_when_summary_row_exists(self):
        p, fixes = normalize_payload("xlsx", {"sheets": [{"name": "V", "headers": ["Item", "Ene"],
                                                          "rows": [["a", 1], ["b", 2], ["TOTAL", "=SUM(B2:B3)"]],
                                                          "summary_row": {"label": "Total"}}]})
        self.assertEqual([r[0] for r in p["sheets"][0]["rows"]], ["a", "b"])
        self.assertIn("xlsx_duplicate_total_row_removed", fixes)

    def test_total_row_is_kept_without_summary_row(self):
        p, _ = normalize_payload("xlsx", {"sheets": [{"name": "V", "headers": ["Item", "Ene"],
                                                      "rows": [["a", 1], ["Total", "=SUM(B2:B2)"]]}]})
        self.assertEqual(len(p["sheets"][0]["rows"]), 2)


class TestDocxNormalize(unittest.TestCase):
    def test_markdown_top_level_becomes_sections(self):
        p, fixes = normalize_payload("docx", {"title": "T", "markdown": "# H\n\ntexto"})
        self.assertEqual([s["type"] for s in p["sections"]], ["heading", "paragraph"])
        self.assertIn("docx_markdown_converted", fixes)
        self.assertNotIn("markdown", p)

    def test_section_aliases(self):
        p, _ = normalize_payload("docx", {"sections": [
            {"type": "h2", "text": "A"},
            {"type": "text", "content": "B"},
            {"type": "list", "items": "x\ny"},
            {"rows": [{"A": 1, "B": 2}]},
        ]})
        s = p["sections"]
        self.assertEqual(s[0], {"type": "heading", "text": "A", "level": 2})
        self.assertEqual((s[1]["type"], s[1]["text"]), ("paragraph", "B"))
        self.assertEqual((s[2]["type"], s[2]["items"]), ("bullets", ["x", "y"]))
        self.assertEqual((s[3]["type"], s[3]["headers"], s[3]["rows"]), ("table", ["A", "B"], [[1, 2]]))

    def test_sections_under_other_key(self):
        p, fixes = normalize_payload("docx", {"content": [{"type": "paragraph", "text": "x"}]})
        self.assertEqual(p["sections"], [{"type": "paragraph", "text": "x"}])
        self.assertIn("docx_sections_from_content", fixes)

    def test_string_sections_become_paragraphs(self):
        p, _ = normalize_payload("docx", {"sections": ["hola", "## Título\n- a\n- b"]})
        self.assertEqual([s["type"] for s in p["sections"]], ["paragraph", "heading", "bullets"])

    def test_paragraph_with_block_markdown_is_expanded(self):
        p, fixes = normalize_payload("docx", {"sections": [{"type": "paragraph", "text": "Intro\n\n- uno\n- dos"}]})
        self.assertEqual([s["type"] for s in p["sections"]], ["paragraph", "bullets"])
        self.assertIn("docx_paragraph_markdown_expanded", fixes)

    def test_inline_only_paragraph_is_kept(self):
        p, _ = normalize_payload("docx", {"sections": [{"type": "paragraph", "text": "Hola **mundo**"}]})
        self.assertEqual(p["sections"], [{"type": "paragraph", "text": "Hola **mundo**"}])

    def test_callout_aliases(self):
        p, _ = normalize_payload("docx", {"sections": [{"type": "warning", "text": "Ojo"}]})
        self.assertEqual(p["sections"][0]["type"], "callout")
        self.assertEqual(p["sections"][0]["variant"], "warning")

    def test_unknown_empty_section_is_dropped(self):
        p, fixes = normalize_payload("docx", {"sections": [{"type": "BOGUS"}, {"type": "paragraph", "text": "x"}]})
        self.assertEqual(len(p["sections"]), 1)
        self.assertTrue(any(f.startswith("docx_section_dropped") for f in fixes))

    def test_nested_bullet_dicts(self):
        p, _ = normalize_payload("docx", {"sections": [{"type": "bullets", "items": [{"content": "a", "subitems": ["a1"]}, 3]}]})
        self.assertEqual(p["sections"][0]["items"], [{"text": "a", "children": ["a1"]}, "3"])

    def test_double_wrapped_data(self):
        p, fixes = normalize_payload("docx", {"data": {"sections": [{"type": "paragraph", "text": "x"}]}})
        self.assertEqual(len(p["sections"]), 1)
        self.assertIn("unwrapped_data", fixes)


class TestCoerceCell(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(coerce_cell("1.500"), 1500)
        self.assertEqual(coerce_cell("1,500.50"), 1500.5)
        self.assertEqual(coerce_cell("12,5"), 12.5)
        self.assertEqual(coerce_cell("3.14"), 3.14)
        self.assertEqual(coerce_cell("-42"), -42)
        self.assertEqual(coerce_cell(" 7 "), 7)

    def test_percent_and_currency(self):
        self.assertEqual(coerce_cell("15%"), {"v": 0.15, "fmt": "0%"})
        self.assertEqual(coerce_cell("12,5 %"), {"v": 0.125, "fmt": "0.0%"})
        self.assertEqual(coerce_cell("$1,200.50"), {"v": 1200.5, "fmt": '"$"#,##0.00'})
        self.assertEqual(coerce_cell("$ 300"), {"v": 300, "fmt": '"$"#,##0'})
        self.assertEqual(coerce_cell("30 €"), {"v": 30, "fmt": '#,##0 "€"'})

    def test_text_that_must_stay_text(self):
        self.assertEqual(coerce_cell("00123"), "00123")
        self.assertEqual(coerce_cell("1234567890123456789"), "1234567890123456789")
        self.assertEqual(coerce_cell("Ene"), "Ene")
        self.assertEqual(coerce_cell("'0042"), "0042")
        self.assertEqual(coerce_cell("=SUM(A1:A3)"), "=SUM(A1:A3)")
        self.assertEqual(coerce_cell("1-2"), "1-2")

    def test_dates(self):
        c = coerce_cell("2024-03-15")
        self.assertEqual(c, {"v": dt.date(2024, 3, 15), "fmt": "dd/mm/yyyy"})
        self.assertEqual(coerce_cell("15/03/2024")["v"], dt.date(2024, 3, 15))
        self.assertEqual(coerce_cell("2024-03-15T10:30:00")["fmt"], "dd/mm/yyyy hh:mm")

    def test_non_strings_untouched(self):
        self.assertEqual(coerce_cell(5), 5)
        self.assertIsNone(coerce_cell(None))
        self.assertIs(coerce_cell(True), True)


class TestXlsxNormalize(unittest.TestCase):
    def test_rows_as_objects(self):
        p, _ = normalize_payload("xlsx", {"sheets": [{"name": "S", "rows": [{"Mes": "Ene", "Total": "10"}]}]})
        self.assertEqual(p["sheets"][0]["headers"], ["Mes", "Total"])
        self.assertEqual(p["sheets"][0]["rows"], [["Ene", 10]])

    def test_top_level_rows_wrapped_in_sheet(self):
        p, fixes = normalize_payload("xlsx", {"title": "Ventas", "headers": ["A"], "rows": [["1"]]})
        self.assertEqual(p["sheets"][0]["headers"], ["A"])
        self.assertEqual(p["sheets"][0]["rows"], [[1]])
        self.assertIn("xlsx_single_sheet_wrapped", fixes)

    def test_sheet_names_are_sanitized_and_unique(self):
        p, _ = normalize_payload("xlsx", {"sheets": [{"name": "Ventas/2024: Q1?", "rows": [[1]]}, {"name": "Ventas/2024: Q1?", "rows": [[2]]}]})
        names = [s["name"] for s in p["sheets"]]
        self.assertEqual(names[0], "Ventas 2024 Q1")
        self.assertNotEqual(names[0], names[1])
        self.assertTrue(all(len(n) <= 31 for n in names))

    def test_chart_aliases(self):
        p, _ = normalize_payload("xlsx", {"sheets": [{"name": "S", "headers": ["M", "T"], "rows": [["a", 1]], "chart": {"type": "column", "series": ["T"]}}]})
        chart = p["sheets"][0]["chart"]
        self.assertEqual(chart["type"], "bar")
        self.assertEqual(chart["series"], [{"column": "T"}])

    def test_boolean_shortcuts(self):
        p, _ = normalize_payload("xlsx", {"sheets": [{"name": "S", "headers": ["A"], "rows": [[1]], "summary_row": True, "freeze": True}]})
        s = p["sheets"][0]
        self.assertEqual(s["summary_row"], {"label": "Total"})
        self.assertEqual(s["freeze"], {"rows": 1, "cols": 0})


class TestPptxNormalize(unittest.TestCase):
    def test_layout_aliases_and_string_bullets(self):
        p, _ = normalize_payload("pptx", {"slides": [{"type": "bullets", "title": "A", "content": "x\ny"}]})
        self.assertEqual(p["slides"][0]["layout"], "content")
        self.assertEqual(p["slides"][0]["bullets"], ["x", "y"])

    def test_markdown_nested_bullets_get_levels(self):
        p, _ = normalize_payload("pptx", {"slides": [{"layout": "content", "title": "A", "bullets": "- a\n  - a1\n- b"}]})
        self.assertEqual(p["slides"][0]["bullets"], ["a", {"text": "a1", "level": 1}, "b"])

    def test_inferred_layouts(self):
        p, _ = normalize_payload("pptx", {"slides": [
            {"title": "Portada", "subtitle": "Sub"},
            {"title": "Datos", "headers": ["a"], "rows": [["1"]]},
            {"title": "KPIs", "stats": [{"value": 92, "label": "x"}]},
            {"title": "Sección"},
        ]})
        self.assertEqual([s["layout"] for s in p["slides"]], ["title", "table", "stats", "section_header"])
        self.assertEqual(p["slides"][2]["stats"][0]["value"], "92")

    def test_theme_keys_and_presets(self):
        p, _ = normalize_payload("pptx", {"theme": {"primary": "#112233", "font": "Arial", "weird": 1}, "slides": [{"layout": "title", "title": "x"}]})
        self.assertEqual(p["theme"], {"primary_color": "#112233", "font_family": "Arial"})
        p2, _ = normalize_payload("pptx", {"theme": "dark", "slides": [{"layout": "title", "title": "x"}]})
        self.assertIn("background_color", p2["theme"])

    def test_two_columns_from_columns_list(self):
        p, _ = normalize_payload("pptx", {"slides": [{"layout": "two_columns", "title": "C", "columns": [{"title": "Pros", "bullets": ["a"]}, {"title": "Contras", "bullets": ["b"]}]}]})
        s = p["slides"][0]
        self.assertEqual((s["left_title"], s["left_column"], s["right_title"], s["right_column"]), ("Pros", ["a"], "Contras", ["b"]))


class TestValidationErrors(unittest.TestCase):
    def test_short_message_with_location(self):
        from schemas.docx import DocxPayload

        with self.assertRaises(Exception) as ctx:
            DocxPayload.model_validate({"sections": [{"type": "nope"}]})
        msg = format_validation_error(ctx.exception)
        self.assertIn("sections.0", msg)
        self.assertLess(len(msg), 700)


class TestCliIntegration(unittest.TestCase):
    def _run(self, fmt, payload):
        return subprocess.run(
            [sys.executable, str(helpers.DOCENGINE_DIR / "cli.py"), "generate", fmt],
            input=json.dumps(payload).encode(),
            capture_output=True,
        )

    def test_cli_normalizes_markdown_docx(self):
        r = self._run("docx", {"markdown": "# Hola\n\nTexto **fuerte**"})
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertEqual(r.stdout[:2], b"PK")
        self.assertIn("docx_markdown_converted", json.loads(r.stderr.decode().strip().splitlines()[-1])["fixes"])

    def test_cli_schema_error_detail_is_short(self):
        r = self._run("pptx", {"slides": [{"layout": "chart", "title": "x", "chart": {"type": "radar_3d"}}]})
        self.assertEqual(r.returncode, 4)
        err = json.loads(r.stderr.decode().strip().splitlines()[-1])
        self.assertEqual(err["error"], "schema_error")
        self.assertLess(len(err["detail"]), 700)
        self.assertIn("slides.0", err["detail"])


if __name__ == "__main__":
    unittest.main()
