import unittest

from docx.enum.text import WD_ALIGN_PARAGRAPH

from tests.helpers import build_docx_doc as build


def all_paragraph_texts(doc):
    texts = [p.text for p in doc.paragraphs]
    for t in doc.tables:
        for r in t.rows:
            for c in r.cells:
                texts.extend(p.text for p in c.paragraphs)
    return texts


class TestDocxBuilder(unittest.TestCase):
    def test_inline_markdown_renders_bold_without_markers(self):
        doc = build({"sections": [{"type": "paragraph", "text": "Hola **mundo** y *algo*"}]})
        bold = [r for p in doc.paragraphs for r in p.runs if r.text == "mundo"]
        italic = [r for p in doc.paragraphs for r in p.runs if r.text == "algo"]
        self.assertTrue(bold and bold[0].bold)
        self.assertTrue(italic and italic[0].italic)
        self.assertNotIn("**", "\n".join(all_paragraph_texts(doc)))

    def test_nested_bullets_use_level_styles(self):
        doc = build({"sections": [{"type": "bullets", "items": [{"text": "a", "children": ["a1"]}, "b"]}]})
        styles = [p.style.name for p in doc.paragraphs if p.text in ("a", "a1", "b")]
        self.assertEqual(styles, ["List Bullet", "List Bullet 2", "List Bullet"])

    def test_numbered_lists_restart_at_one(self):
        doc = build({"sections": [
            {"type": "numbered", "items": ["uno", "dos"]},
            {"type": "paragraph", "text": "medio"},
            {"type": "numbered", "items": ["otro"]},
        ]})
        num_ids = []
        for p in doc.paragraphs:
            if p.text in ("uno", "otro"):
                num_pr = p._p.pPr.numPr
                self.assertIsNotNone(num_pr, p.text)
                num_ids.append(num_pr.numId.val)
        self.assertEqual(len(num_ids), 2)
        self.assertNotEqual(num_ids[0], num_ids[1])

    def test_table_header_repeat_numeric_alignment_and_format(self):
        doc = build({"sections": [{"type": "table", "headers": ["Nombre", "Monto"], "rows": [["Ana", 1500], ["Beto", 2.5]]}]})
        t = doc.tables[0]
        self.assertIn("tblHeader", t.rows[0]._tr.xml)
        self.assertEqual(t.rows[1].cells[1].text, "1.500")
        self.assertEqual(t.rows[2].cells[1].text, "2,50")
        self.assertEqual(t.rows[1].cells[1].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)
        self.assertNotEqual(t.rows[1].cells[0].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)

    def test_numeric_looking_strings_align_right_and_keep_text(self):
        doc = build({"sections": [{"type": "table", "headers": ["Mes", "Ventas", "Var"],
                                   "rows": [["Ene", "455.000", "25%"], ["Feb", 1200, "-3%"]]}]})
        t = doc.tables[0]
        self.assertEqual(t.rows[1].cells[1].text, "455.000")
        self.assertEqual(t.rows[1].cells[1].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)
        self.assertEqual(t.rows[1].cells[2].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)
        self.assertEqual(t.rows[0].cells[1].paragraphs[0].alignment, WD_ALIGN_PARAGRAPH.RIGHT)
        self.assertEqual(t.rows[2].cells[1].text, "1.200")

    def test_table_cells_render_inline_markdown(self):
        doc = build({"sections": [{"type": "table", "headers": ["A"], "rows": [["**fuerte**"]]}]})
        cell = doc.tables[0].rows[1].cells[0]
        self.assertEqual(cell.text, "fuerte")
        self.assertTrue(cell.paragraphs[0].runs[0].bold)

    def test_callout_contains_title_and_text(self):
        doc = build({"sections": [{"type": "callout", "variant": "warning", "title": "Atención", "text": "Ojo **acá**"}]})
        texts = all_paragraph_texts(doc)
        self.assertIn("Atención", texts)
        self.assertIn("Ojo acá", texts)

    def test_title_and_subtitle_use_document_styles(self):
        doc = build({"title": "Informe Q3", "subtitle": "Ventas", "sections": [{"type": "paragraph", "text": "x"}]})
        by_text = {p.text: p for p in doc.paragraphs}
        self.assertEqual(by_text["Informe Q3"].style.name, "Title")
        self.assertEqual(by_text["Ventas"].style.name, "Subtitle")
        # El estilo Título no suma el borde de la plantilla: la línea la dibuja el bloque de título.
        self.assertIsNone(doc.styles["Title"].element.find(".//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pBdr"))
        self.assertEqual(doc.core_properties.title, "Informe Q3")

    def test_cover_title_uses_title_style(self):
        doc = build({"title": "Plan", "cover": {"subtitle": "Anual"}, "sections": [{"type": "paragraph", "text": "x"}]})
        styles = {p.text: p.style.name for p in doc.paragraphs if p.text in ("Plan", "Anual")}
        self.assertEqual(styles, {"Plan": "Title", "Anual": "Subtitle"})

    def test_cover_page_then_page_break(self):
        doc = build({"title": "Informe Anual", "subtitle": "2026", "cover": True, "meta": {"author": "Ana"},
                     "sections": [{"type": "paragraph", "text": "cuerpo"}]})
        body_xml = doc.element.body.xml
        self.assertLess(body_xml.index("Informe Anual"), body_xml.index('w:type="page"'))
        self.assertLess(body_xml.index('w:type="page"'), body_xml.index("cuerpo"))

    def test_footer_has_page_x_of_y(self):
        doc = build({"sections": [{"type": "paragraph", "text": "x"}]})
        xml = doc.sections[0].footer._element.xml
        self.assertIn("PAGE", xml)
        self.assertIn("NUMPAGES", xml)

    def test_footer_can_be_disabled(self):
        doc = build({"show_page_numbers": False, "sections": [{"type": "paragraph", "text": "x"}]})
        self.assertNotIn("NUMPAGES", doc.sections[0].footer._element.xml)

    def test_heading_strips_markers_and_uses_style(self):
        doc = build({"sections": [{"type": "heading", "text": "**Resumen**", "level": 2}]})
        h = [p for p in doc.paragraphs if p.text == "Resumen"][0]
        self.assertEqual(h.style.name, "Heading 2")

    def test_code_block_keeps_line_breaks(self):
        doc = build({"sections": [{"type": "code", "text": "a = 1\nb = 2"}]})
        p = [p for p in doc.paragraphs if "a = 1" in p.text][0]
        self.assertIn("\n", p.text)

    def test_link_in_paragraph_becomes_hyperlink(self):
        doc = build({"sections": [{"type": "paragraph", "text": "Ver [sitio](https://example.com)"}]})
        self.assertIn("w:hyperlink", doc.paragraphs[-1]._p.xml)

    def test_font_family_applies_to_east_asian_too(self):
        doc = build({"theme": {"font_family": "Arial"}, "sections": [{"type": "paragraph", "text": "x"}]})
        rpr = doc.styles["Normal"].element.rPr
        self.assertIn('w:eastAsia="Arial"', rpr.xml)


    def test_chosen_font_beats_theme_fonts_in_headings(self):
        doc = build({"theme": {"font_family": "Arial"}, "sections": [{"type": "heading", "text": "Hola", "level": 1}]})
        for name in ("Heading 1", "Title"):
            xml = doc.styles[name].element.rPr.xml
            self.assertIn('w:ascii="Arial"', xml, name)
            self.assertNotIn("Theme=", xml, name)

if __name__ == "__main__":
    unittest.main()
