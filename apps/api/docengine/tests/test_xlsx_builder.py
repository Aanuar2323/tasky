import datetime as dt
import io
import unittest

from openpyxl import load_workbook

from tests.helpers import build_xlsx_bytes, build_xlsx_wb as build, zip_parts


class TestXlsxBuilder(unittest.TestCase):
    def test_numbers_are_numeric_and_excel_table_created(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Total"], "rows": [["Ene", "1.500"], ["Feb", "2.300"]]}]})
        ws = wb["V"]
        self.assertEqual(ws["B2"].value, 1500)
        self.assertEqual(len(ws.tables), 1)
        table = list(ws.tables.values())[0]
        self.assertEqual(table.ref, "A1:B3")

    def test_duplicate_or_empty_headers_still_make_a_table(self):
        wb = build({"sheets": [{"name": "V", "headers": ["A", "A", ""], "rows": [[1, 2, 3]]}]})
        ws = wb["V"]
        self.assertEqual(len(ws.tables), 1)
        headers = [ws.cell(row=1, column=c).value for c in range(1, 4)]
        self.assertEqual(len(set(headers)), 3)
        self.assertTrue(all(headers))

    def test_summary_row_only_on_numeric_columns(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Nota", "Total"], "rows": [["Ene", "x", 1], ["Feb", "y", 2]],
                                "summary_row": {"label": "Total"}}]})
        ws = wb["V"]
        self.assertEqual(ws["A4"].value, "Total")
        self.assertIsNone(ws["B4"].value)
        self.assertEqual(ws["C4"].value, "=SUM(C2:C3)")

    def test_percent_format_and_default_freeze_below_header(self):
        wb = build({"sheets": [{"name": "V", "headers": ["A", "P"], "rows": [["x", "15%"]]}]})
        ws = wb["V"]
        self.assertEqual(ws["B2"].value, 0.15)
        self.assertEqual(ws["B2"].number_format, "0%")
        self.assertEqual(ws.freeze_panes, "A2")

    def test_title_row_shifts_table_and_freeze(self):
        wb = build({"sheets": [{"name": "V", "title": "Reporte", "headers": ["A", "B"], "rows": [["x", 1]]}]})
        ws = wb["V"]
        self.assertEqual(ws["A1"].value, "Reporte")
        self.assertEqual(ws["A3"].value, "A")
        self.assertEqual(list(ws.tables.values())[0].ref, "A3:B4")
        self.assertEqual(ws.freeze_panes, "A4")

    def test_dates_get_date_format(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Fecha"], "rows": [["2026-01-31"]]}]})
        ws = wb["V"]
        self.assertEqual(ws["A2"].value.date(), dt.date(2026, 1, 31))
        self.assertEqual(ws["A2"].number_format, "dd/mm/yyyy")

    def test_number_formats_by_header_name(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Item", "Monto"], "rows": [["a", 10], ["b", 20]],
                                "number_formats": {"Monto": "#,##0.00"}}]})
        ws = wb["V"]
        self.assertEqual(ws["B2"].number_format, "#,##0.00")
        self.assertEqual(ws["B3"].number_format, "#,##0.00")

    def test_formulas_are_preserved(self):
        wb = build({"sheets": [{"name": "V", "headers": ["A", "B"], "rows": [[2, "=A2*2"]]}]})
        self.assertEqual(wb["V"]["B2"].value, "=A2*2")

    def test_formulas_follow_the_title_offset(self):
        # El modelo escribe como si el encabezado estuviera en la fila 1; el título corre todo dos filas.
        wb = build({"sheets": [{"name": "V", "title": "Ventas", "headers": ["Item", "Ene", "Feb", "Total"],
                                "rows": [["a", 1, 2, "=B2+C2"], ["b", 3, 4, "=SUM(B3:C3)"],
                                         ["Suma", "=SUM(B2:B3)", "=SUM($C$2:$C$3)", "=Otra!B2+B3"]]}]})
        ws = wb["V"]
        self.assertEqual(ws["D4"].value, "=B4+C4")
        self.assertEqual(ws["D5"].value, "=SUM(B5:C5)")
        self.assertEqual(ws["B6"].value, "=SUM(B4:B5)")
        self.assertEqual(ws["C6"].value, "=SUM($C$4:$C$5)")
        # Referencias a otra hoja no se tocan; las locales sí.
        self.assertEqual(ws["D6"].value, "=Otra!B2+B5")

    def test_formula_text_literals_are_not_shifted(self):
        wb = build({"sheets": [{"name": "V", "title": "T", "headers": ["A", "B"], "rows": [[1, '=IF(A2>0,"A2 ok","no")']]}]})
        self.assertEqual(wb["V"]["B4"].value, '=IF(A4>0,"A2 ok","no")')

    def test_manual_total_row_stays_out_of_table_and_chart(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "Monto"],
                                             "rows": [["Ene", 1000], ["Feb", 2000], ["Total", "=SUM(B2:B3)"]],
                                             "chart": {"type": "bar", "title": "T"}}]})
        wb = load_workbook(io.BytesIO(data))
        ws = wb["V"]
        self.assertEqual(list(ws.tables.values())[0].ref, "A1:B3")
        self.assertTrue(ws["A4"].font.bold)
        self.assertTrue(ws["B4"].font.bold)
        self.assertEqual(ws["B4"].number_format, ws["B2"].number_format)
        chart = zip_parts(data, "xl/charts/chart")[0]
        self.assertIn("$B$2:$B$3", chart)
        self.assertNotIn("$B$2:$B$4", chart)

    def test_column_width_follows_content(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Id", "Descripción"], "rows": [[1, "Un texto bastante largo para la columna"]]}]})
        ws = wb["V"]
        self.assertGreater(ws.column_dimensions["B"].width, ws.column_dimensions["A"].width + 15)

    def test_data_validation_is_applied(self):
        wb = build({"sheets": [{"name": "V", "headers": ["N"], "rows": [[1]],
                                "data_validations": [{"cells": "A2:A10", "type": "whole", "operator": "between", "formula1": "1", "formula2": "5"}]}]})
        self.assertEqual(len(wb["V"].data_validations.dataValidation), 1)

    def test_chart_references_real_data_range(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "Total"], "rows": [["Ene", 1], ["Feb", 2]],
                                             "chart": {"type": "bar", "title": "T"}}]})
        charts = zip_parts(data, "xl/charts/chart")
        self.assertEqual(len(charts), 1)
        self.assertIn("$B$2:$B$3", charts[0])
        self.assertIn("$A$2:$A$3", charts[0])
        self.assertIn('<delete val="0"/>', charts[0])

    def test_chart_series_by_header_name(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "Costo", "Venta"], "rows": [["Ene", 1, 5], ["Feb", 2, 6]],
                                             "chart": {"type": "line", "series": [{"column": "Venta"}]}}]})
        chart = zip_parts(data, "xl/charts/chart")[0]
        self.assertIn("$C$2:$C$3", chart)
        self.assertNotIn("$B$2:$B$3", chart)

    def test_explicit_series_go_to_hidden_sheet(self):
        wb = build({"sheets": [{"name": "V", "headers": ["A"], "rows": [["x"]],
                                "chart": {"type": "pie", "labels": ["a", "b"], "series": [{"name": "s", "values": [1, 2]}]}}]})
        self.assertIn("_datos_graficos", wb.sheetnames)
        self.assertEqual(wb["_datos_graficos"].sheet_state, "hidden")
        self.assertEqual(wb.active.title, "V")

    def test_multiple_charts_do_not_share_anchor(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "A", "B"], "rows": [["Ene", 1, 2], ["Feb", 3, 4]],
                                             "charts": [{"type": "bar", "series": ["A"]}, {"type": "line", "series": ["B"]}]}]})
        drawing = zip_parts(data, "xl/drawings/drawing")[0]
        rows = [chunk.split("</row>")[0] for chunk in drawing.split("<from>")[1:]]
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0], rows[1])

    def test_horizontal_bar_and_scatter(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["X", "Y"], "rows": [[1, 2], [2, 4]],
                                             "charts": [{"type": "bar", "horizontal": True, "series": ["Y"]},
                                                        {"type": "scatter", "series": ["Y"], "labels_column": "X"}]}]})
        charts = zip_parts(data, "xl/charts/chart")
        self.assertIn('<barDir val="bar"/>', charts[0])
        self.assertIn("<scatterChart>", charts[1])

    def test_numeric_columns_get_consistent_default_format(self):
        wb = build({"sheets": [{"name": "V", "headers": ["Mes", "Unidades", "Precio", "Monto"],
                                "rows": [["Ene", 12500, 2.5, "$15,800"], ["Feb", 300, 3.25, 900]]}]})
        ws = wb["V"]
        self.assertEqual(ws["B2"].number_format, "#,##0")
        self.assertEqual(ws["C2"].number_format, "#,##0.00")
        self.assertEqual(ws["D3"].number_format, ws["D2"].number_format)
        self.assertIn("$", ws["D3"].number_format)

    def test_chart_has_cached_values_and_text_categories(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "Total"], "rows": [["Ene", 10], ["Feb", 20]],
                                             "chart": {"type": "bar"}}]})
        chart = zip_parts(data, "xl/charts/chart")[0]
        self.assertIn("<strRef><f>'V'!$A$2:$A$3</f><strCache>", chart)
        self.assertIn("<v>Ene</v>", chart)
        self.assertIn("<numCache>", chart)
        self.assertIn("<v>20</v>", chart)

    def test_axes_positions_and_crossing(self):
        data = build_xlsx_bytes({"sheets": [{"name": "V", "headers": ["Mes", "T"], "rows": [["a", 1], ["b", 2]],
                                             "charts": [{"type": "bar"}, {"type": "bar", "horizontal": True}]}]})
        col_chart, bar_chart = zip_parts(data, "xl/charts/chart")
        self.assertIn('<catAx><axId val="10"/><scaling><orientation val="minMax"/></scaling><delete val="0"/><axPos val="b"/>', col_chart)
        self.assertIn('<axPos val="l"/>', bar_chart.split("<catAx>")[1].split("</catAx>")[0])
        self.assertIn('<crosses val="autoZero"/>', col_chart)

    def test_print_setup_fits_width(self):
        wb = build({"sheets": [{"name": "V", "headers": ["A"], "rows": [[1]]}]})
        ws = wb["V"]
        self.assertTrue(ws.sheet_properties.pageSetUpPr.fitToPage)
        self.assertEqual(ws.page_setup.fitToWidth, 1)

    def test_sheet_without_headers_writes_rows(self):
        wb = build({"sheets": [{"name": "V", "rows": [["a", 1], ["b", 2]]}]})
        ws = wb["V"]
        self.assertEqual(ws["A1"].value, "a")
        self.assertEqual(ws["B2"].value, 2)


if __name__ == "__main__":
    unittest.main()
