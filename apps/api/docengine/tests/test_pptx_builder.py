import unittest

from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Pt

from tests.helpers import build_pptx_prs as build


def texts(slide):
    return [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame]


def paragraphs(slide):
    return [p for sh in slide.shapes if sh.has_text_frame for p in sh.text_frame.paragraphs]


def run_sizes(slide, text):
    return [r.font.size for p in paragraphs(slide) if p.text == text for r in p.runs]


class TestPptxBuilder(unittest.TestCase):
    def test_slide_numbers_and_footer_skip_title_slide(self):
        prs = build({"footer": "ACME · Q3", "slides": [{"layout": "title", "title": "A"}, {"layout": "content", "title": "B", "bullets": ["x"]}]})
        self.assertNotIn("1", texts(prs.slides[0]))
        self.assertIn("2", texts(prs.slides[1]))
        self.assertIn("ACME · Q3", texts(prs.slides[1]))

    def test_long_table_splits_into_continuation_slides(self):
        rows = [[str(i), i * 2] for i in range(25)]
        prs = build({"slides": [{"layout": "table", "title": "T", "headers": ["a", "b"], "rows": rows}]})
        self.assertEqual(len(prs.slides), 3)
        self.assertIn("T (cont.)", texts(prs.slides[1]))
        tables = [sh.table for sh in prs.slides[2].shapes if sh.has_table]
        self.assertEqual(len(tables[0].rows), 6)  # encabezado + 5

    def test_sub_bullets_have_level(self):
        prs = build({"slides": [{"layout": "content", "title": "T", "bullets": ["a", {"text": "a1", "level": 1}]}]})
        levels = {p.text: p.level for p in paragraphs(prs.slides[0])}
        self.assertEqual(levels["a"], 0)
        self.assertEqual(levels["a1"], 1)

    def test_font_shrinks_with_dense_bullets(self):
        few = build({"slides": [{"layout": "content", "title": "T", "bullets": ["uno", "dos"]}]})
        dense_bullets = [f"Punto {i}: " + "texto largo de ejemplo " * 4 for i in range(9)]
        many = build({"slides": [{"layout": "content", "title": "T", "bullets": dense_bullets}]})
        self.assertGreaterEqual(run_sizes(few.slides[0], "uno")[0], Pt(22))
        self.assertLessEqual(run_sizes(many.slides[0], dense_bullets[0].strip())[0], Pt(16))

    def test_stats_layout_shows_values_and_labels(self):
        prs = build({"slides": [{"layout": "stats", "title": "KPIs", "stats": [{"value": "92%", "label": "Satisfacción"}, {"value": "1.2M", "label": "Usuarios", "detail": "+8% interanual"}]}]})
        alltext = " ".join(texts(prs.slides[0]))
        for t in ("92%", "Satisfacción", "1.2M", "Usuarios", "+8% interanual"):
            self.assertIn(t, alltext)

    def test_agenda_numbers_items(self):
        prs = build({"slides": [{"layout": "agenda", "items": ["Contexto", "Propuesta", "Próximos pasos"]}]})
        t = texts(prs.slides[0])
        for expected in ("Agenda", "1", "2", "3", "Contexto", "Próximos pasos"):
            self.assertIn(expected, t)

    def test_chart_types(self):
        def chart_type(chart):
            prs = build({"slides": [{"layout": "chart", "title": "C", "chart": chart}]})
            return [sh for sh in prs.slides[0].shapes if sh.has_chart][0].chart.chart_type

        base = {"labels": ["1", "2"], "series": [{"name": "s", "values": [3, 4]}]}
        self.assertEqual(chart_type({**base, "type": "scatter"}), XL_CHART_TYPE.XY_SCATTER)
        self.assertEqual(chart_type({**base, "type": "doughnut"}), XL_CHART_TYPE.DOUGHNUT)
        self.assertEqual(chart_type({**base, "type": "bar", "horizontal": True}), XL_CHART_TYPE.BAR_CLUSTERED)
        self.assertEqual(chart_type({**base, "type": "bar", "stacked": True}), XL_CHART_TYPE.COLUMN_STACKED)
        self.assertEqual(chart_type({**base, "type": "area"}), XL_CHART_TYPE.AREA)
        self.assertEqual(chart_type({**base, "type": "line"}), XL_CHART_TYPE.LINE_MARKERS)

    def test_chart_values_coerced_from_text(self):
        prs = build({"slides": [{"layout": "chart", "title": "C", "chart": {"type": "bar", "labels": ["a", "b"], "series": [{"name": "s", "values": ["1.500", "2,5"]}]}}]})
        chart = [sh for sh in prs.slides[0].shapes if sh.has_chart][0].chart
        self.assertEqual(list(chart.plots[0].series[0].values), [1500.0, 2.5])

    def test_notes_and_two_column_titles(self):
        prs = build({"slides": [{"layout": "two_columns", "title": "C", "left_title": "Pros", "right_title": "Contras",
                                 "left_column": ["a"], "right_column": ["b"], "notes": "Decir esto"}]})
        self.assertIn("Pros", texts(prs.slides[0]))
        self.assertIn("Contras", texts(prs.slides[0]))
        self.assertEqual(prs.slides[0].notes_slide.notes_text_frame.text, "Decir esto")

    def test_title_slide_shows_subtitle_and_author(self):
        prs = build({"author": "Ana Pérez", "slides": [{"layout": "title", "title": "Plan 2027", "subtitle": "Propuesta"}]})
        alltext = " ".join(texts(prs.slides[0]))
        self.assertIn("Plan 2027", alltext)
        self.assertIn("Propuesta", alltext)
        self.assertIn("Ana Pérez", alltext)

    def test_slide_is_16_9(self):
        prs = build({"slides": [{"layout": "title", "title": "x"}]})
        self.assertAlmostEqual(prs.slide_width / prs.slide_height, 16 / 9, places=2)


if __name__ == "__main__":
    unittest.main()
