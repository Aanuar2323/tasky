import base64
import io
import json
import subprocess
import sys
import unittest

from docx import Document
from openpyxl import Workbook, load_workbook
from pptx import Presentation
from pptx.util import Inches

from tests import helpers
from builders.docx_editor import edit_docx
from builders.pptx_editor import edit_pptx
from builders.xlsx_editor import edit_xlsx


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def docx_with_runs(parts, bold_first=False):
    doc = Document()
    p = doc.add_paragraph()
    for i, t in enumerate(parts):
        r = p.add_run(t)
        if bold_first and i == 0:
            r.bold = True
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def docx_with_table_and_footer():
    doc = Document()
    doc.add_paragraph("Cuerpo")
    t = doc.add_table(rows=1, cols=1)
    t.rows[0].cells[0].paragraphs[0].add_run("Total: ")
    t.rows[0].cells[0].paragraphs[0].add_run("{{monto}}")
    doc.sections[0].footer.paragraphs[0].add_run("Cliente: {{cliente}}")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def pptx_with_text(text_parts):
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    box = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1))
    p = box.text_frame.paragraphs[0]
    for t in text_parts:
        p.add_run().text = t
    table = slide.shapes.add_table(1, 1, Inches(1), Inches(3), Inches(4), Inches(1)).table
    table.cell(0, 0).text = "Monto {{monto}}"
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()


def pptx_all_text(data: bytes) -> str:
    prs = Presentation(io.BytesIO(data))
    out = []
    for slide in prs.slides:
        for sh in slide.shapes:
            if sh.has_text_frame:
                out.append(sh.text_frame.text)
            if sh.has_table:
                out.extend(c.text for r in sh.table.rows for c in r.cells)
    return "\n".join(out)


def xlsx_simple():
    wb = Workbook()
    ws = wb.active
    ws.title = "Hoja"
    ws.append(["Nombre", "Monto"])
    ws.append(["Ana", 10])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestDocxEditor(unittest.TestCase):
    def test_template_replaces_across_runs(self):
        out, stats = edit_docx(b64(docx_with_runs(["Hola ", "{{cli", "ente}}", " fin"])), {"template": {"cliente": "ACME"}})
        self.assertEqual(Document(io.BytesIO(out)).paragraphs[0].text, "Hola ACME fin")
        self.assertEqual(stats["replacements"], 1)

    def test_template_key_with_braces_also_works(self):
        out, _ = edit_docx(b64(docx_with_runs(["Para {{cliente}}"])), {"template": {"{{cliente}}": "ACME"}})
        self.assertEqual(Document(io.BytesIO(out)).paragraphs[0].text, "Para ACME")

    def test_replace_keeps_first_run_formatting(self):
        out, _ = edit_docx(b64(docx_with_runs(["orig", "inal texto"], bold_first=True)), {"replace": [{"find": "original", "replace": "editado"}]})
        p = Document(io.BytesIO(out)).paragraphs[0]
        self.assertEqual(p.text, "editado texto")
        self.assertTrue(p.runs[0].bold)

    def test_replaces_in_tables_and_footer(self):
        out, stats = edit_docx(b64(docx_with_table_and_footer()), {"template": {"monto": "$100", "cliente": "ACME"}})
        doc = Document(io.BytesIO(out))
        self.assertEqual(doc.tables[0].rows[0].cells[0].text, "Total: $100")
        self.assertEqual(doc.sections[0].footer.paragraphs[0].text, "Cliente: ACME")
        self.assertEqual(stats["replacements"], 2)

    def test_multiple_occurrences_in_one_paragraph(self):
        out, stats = edit_docx(b64(docx_with_runs(["a-b-a"])), {"replace": [{"find": "a", "replace": "xx"}]})
        self.assertEqual(Document(io.BytesIO(out)).paragraphs[0].text, "xx-b-xx")
        self.assertEqual(stats["replacements"], 2)

    def test_no_match_reports_zero(self):
        _, stats = edit_docx(b64(docx_with_runs(["nada"])), {"replace": [{"find": "zzz", "replace": "y"}]})
        self.assertEqual(stats["replacements"], 0)

    def test_append_markdown_adds_content_at_end(self):
        out, stats = edit_docx(b64(docx_with_runs(["Inicio"])), {"append_markdown": "## Conclusión\n\nTexto **final**."})
        doc = Document(io.BytesIO(out))
        texts = [p.text for p in doc.paragraphs]
        self.assertEqual(texts[0], "Inicio")
        self.assertIn("Conclusión", texts)
        self.assertIn("Texto final.", texts)
        self.assertEqual(stats["appended_blocks"], 2)


class TestPptxEditor(unittest.TestCase):
    def test_template_with_and_without_braces_across_runs(self):
        for key in ("{{cliente}}", "cliente"):
            out, stats = edit_pptx(b64(pptx_with_text(["Para {{cli", "ente}}"])), {"template": {key: "ACME", "monto": "$5"}})
            text = pptx_all_text(out)
            self.assertIn("Para ACME", text)
            self.assertIn("Monto $5", text)
            self.assertEqual(stats["replacements"], 2)

    def test_replace_list(self):
        out, _ = edit_pptx(b64(pptx_with_text(["Hola mundo"])), {"replace": [{"find": "mundo", "replace": "equipo"}]})
        self.assertIn("Hola equipo", pptx_all_text(out))


class TestXlsxEditor(unittest.TestCase):
    def test_new_sheet_and_update(self):
        out, stats = edit_xlsx(b64(xlsx_simple()), {"sheets": [
            {"name": "Nueva", "create": True, "add_rows": [["a", "1.500"]]},
            {"name": "Hoja", "update_cells": [{"cell": "A1", "value": "Persona"}, {"cell": "B2", "value": "15%"}]},
        ]})
        wb = load_workbook(io.BytesIO(out))
        self.assertIn("Nueva", wb.sheetnames)
        self.assertEqual(wb["Nueva"]["B1"].value, 1500)
        self.assertEqual(wb["Hoja"]["A1"].value, "Persona")
        self.assertEqual(wb["Hoja"]["B2"].value, 0.15)
        self.assertEqual(wb["Hoja"]["B2"].number_format, "0%")
        self.assertEqual(stats["cells_updated"], 2)

    def test_add_rows_appends_after_last_row(self):
        out, _ = edit_xlsx(b64(xlsx_simple()), {"sheets": [{"name": "Hoja", "add_rows": [["Beto", 20]]}]})
        ws = load_workbook(io.BytesIO(out))["Hoja"]
        self.assertEqual(ws["A3"].value, "Beto")
        self.assertEqual(ws["B3"].value, 20)

    def test_unknown_sheet_error_lists_existing(self):
        with self.assertRaises(ValueError) as ctx:
            edit_xlsx(b64(xlsx_simple()), {"sheets": [{"name": "Otra", "update_cells": [{"cell": "A1", "value": 1}]}]})
        self.assertIn("Hoja", str(ctx.exception))

    def test_global_replace_in_text_cells(self):
        out, stats = edit_xlsx(b64(xlsx_simple()), {"replace": [{"find": "Ana", "replace": "Ana María"}]})
        self.assertEqual(load_workbook(io.BytesIO(out))["Hoja"]["A2"].value, "Ana María")
        self.assertEqual(stats["replacements"], 1)

    def test_rename_sheet(self):
        out, _ = edit_xlsx(b64(xlsx_simple()), {"sheets": [{"name": "Hoja", "rename": "Datos"}]})
        self.assertEqual(load_workbook(io.BytesIO(out)).sheetnames, ["Datos"])


class TestCliEditStats(unittest.TestCase):
    def test_cli_edit_reports_stats_on_stderr(self):
        payload = {"file_base64": b64(docx_with_runs(["Hola {{x}}"])), "changes": {"template": {"x": "mundo"}}}
        r = subprocess.run([sys.executable, str(helpers.DOCENGINE_DIR / "cli.py"), "edit", "docx"],
                           input=json.dumps(payload).encode(), capture_output=True)
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertEqual(r.stdout[:2], b"PK")
        self.assertEqual(json.loads(r.stderr.decode().strip().splitlines()[-1])["stats"]["replacements"], 1)


if __name__ == "__main__":
    unittest.main()
