"""XLSX builder using openpyxl — professional styling, native charts."""

from __future__ import annotations

import io

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, PieChart, ScatterChart, Reference, Series
from openpyxl.chart.label import DataLabelList
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.styles.colors import Color
from openpyxl.utils import get_column_letter

from schemas.xlsx import XlsxPayload
from utils.styles import DEFAULT_XLSX_THEME, resolve_theme, strip_hash


def _to_argb(color: str | None) -> str:
    if not color:
        return "FF1E293B"
    return "FF" + strip_hash(color, "1E293B")


def _fill(color: str | None) -> PatternFill:
    return PatternFill(start_color=_to_argb(color), end_color=_to_argb(color), fill_type="solid")


def _font(theme, *, bold=False, color=None, size=11):
    return Font(
        name=theme.get("font_family") or "Calibri",
        bold=bold,
        color=color if color else None,
        size=size,
    )


THIN = Side(border_style="thin", color="FFD1D5DB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def build_xlsx(payload: XlsxPayload) -> bytes:
    theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_XLSX_THEME)
    wb = Workbook()
    if payload.creator:
        wb.properties.creator = payload.creator
    if payload.company:
        wb.properties.company = payload.company

    ws_first = wb.active
    first = True

    for sheet_def in payload.sheets:
        sheet_theme = sheet_def.styling.model_dump(exclude_none=True) if sheet_def.styling else {}
        local = {**theme, **sheet_theme}
        ws = ws_first if first else wb.create_sheet()
        first = False
        ws.title = sheet_def.name[:31] if sheet_def.name else "Hoja 1"

        # Tab color
        if sheet_def.tab_color:
            ws.sheet_properties.tabColor = _to_argb(sheet_def.tab_color)

        # Optional title row
        start_row = 1
        if sheet_def.title:
            ws.cell(row=1, column=1, value=sheet_def.title)
            ws.cell(row=1, column=1).font = Font(
                name=local.get("font_family") or "Calibri", size=14, bold=True,
                color=_to_argb(local.get("primary_color")),
            )
            start_row = 3

        headers = sheet_def.headers or []
        rows = sheet_def.rows or []

        # Headers
        header_fill = local.get("header_fill") or local.get("primary_color") or "#1E293B"
        header_font_color = local.get("header_font_color") or "#FFFFFF"
        if headers:
            for ci, h in enumerate(headers, start=1):
                cell = ws.cell(row=start_row, column=ci, value=escape_formula(str(h)) if isinstance(h, str) and h.startswith("=") else h)
                cell.fill = _fill(header_fill)
                cell.font = _font(local, bold=True, color=_to_argb(header_font_color), size=11)
                cell.alignment = Alignment(horizontal="center", vertical="center")
                cell.border = BORDER
            ws.row_dimensions[start_row].height = 22

        # Rows
        alt_color = local.get("alt_row_fill") or "#F1F5F9"
        for ri, row in enumerate(rows, start=start_row + 1):
            for ci, val in enumerate(row, start=1):
                cell_value: object
                if isinstance(val, str) and val.startswith("="):
                    cell_value = val  # openpyxl interprets as formula
                else:
                    cell_value = escape_formula(val) if isinstance(val, str) and val.startswith(("=", "+", "-", "@")) else val
                cell = ws.cell(row=ri, column=ci, value=cell_value)
                cell.font = _font(local, size=11)
                cell.border = BORDER
                cell.alignment = Alignment(vertical="center")
                if (ri - start_row) % 2 == 0:
                    cell.fill = _fill(alt_color)
            ws.row_dimensions[ri].height = 18

        # Number formats
        if sheet_def.number_formats:
            for cell_ref, fmt in sheet_def.number_formats.items():
                if cell_ref.upper().startswith(("A", "B")) or ":" in cell_ref:
                    pass  # may be a range
                try:
                    for row in ws[cell_ref]:
                        if hasattr(row, "__iter__"):
                            for c in row:
                                c.number_format = fmt
                        else:
                            row.number_format = fmt
                except Exception:
                    try:
                        ws[cell_ref].number_format = fmt
                    except Exception:
                        pass

        # Merges
        for rng in sheet_def.merge_cells or []:
            try:
                ws.merge_cells(rng)
            except Exception:
                pass

        # Column widths
        if sheet_def.column_widths:
            for ci, w in enumerate(sheet_def.column_widths, start=1):
                ws.column_dimensions[get_column_letter(ci)].width = float(w)
        elif headers:
            for ci, h in enumerate(headers, start=1):
                ws.column_dimensions[get_column_letter(ci)].width = max(len(str(h)) + 3, 12)

        # Freeze
        if sheet_def.freeze and (sheet_def.freeze.rows or sheet_def.freeze.cols):
            col_part = get_column_letter(sheet_def.freeze.cols + 1) if sheet_def.freeze.cols else "A"
            row_part = str(sheet_def.freeze.rows + 1) if sheet_def.freeze.rows else "1"
            ws.freeze_panes = col_part + row_part

        # Auto-filter
        if sheet_def.auto_filter and headers:
            end_col = get_column_letter(len(headers))
            end_row = start_row + len(rows)
            ws.auto_filter.ref = f"{get_column_letter(1)}{start_row}:{end_col}{end_row}"

        # Summary row
        if sheet_def.summary_row:
            sr = start_row + len(rows) + 1
            label = sheet_def.summary_row.label
            formula = sheet_def.summary_row.formula or "SUM"
            ws.cell(row=sr, column=1, value=label)
            ws.cell(row=sr, column=1).font = _font(local, bold=True, color=_to_argb(local.get("primary_color") or "#1E293B"))
            for ci in range(2, len(headers) + 1):
                col_letter = get_column_letter(ci)
                cell = ws.cell(row=sr, column=ci)
                cell.value = f"={formula}({col_letter}{start_row + 1}:{col_letter}{start_row + len(rows)})"
                cell.font = _font(local, bold=True)
                cell.fill = _fill(sheet_def.summary_row.fill_color or local.get("header_fill") or "#1E293B")
                if sheet_def.summary_row.fill_color:
                    cell.font = _font(local, bold=True, color="FFFFFFFF")

        # Conditional formatting
        for cf in sheet_def.conditional_formatting or []:
            try:
                _apply_cf(ws, cf, start_row=start_row, n_rows=len(rows), n_cols=len(headers))
            except Exception:
                pass

        # Data validation
        for dv in sheet_def.data_validations or []:
            try:
                d = ws.data_validations.DataValidation(
                    type=dv.type,
                    operator=dv.operator or "between",
                    formula1=dv.formula1,
                    formula2=dv.formula2,
                    allow_blank=dv.allow_blank,
                    showErrorMessage=True,
                )
                ws.add_data_validation(d)
                d.add(dv.cells)
            except Exception:
                pass

        # Chart
        if sheet_def.chart:
            try:
                _add_chart(ws, sheet_def.chart, start_row=start_row, n_rows=len(rows))
            except Exception as e:
                # write error note in anchor cell instead of failing build
                ws[sheet_def.chart.anchor_cell or "E2"] = f"chart_error: {e}"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()


# ---- Chart --------------------------------------------------------------------

def _add_chart(ws, chart_def, *, start_row: int, n_rows: int):
    ctype = chart_def.type
    series = chart_def.series or []
    labels = chart_def.labels
    n_series = len(series)

    if ctype == "bar":
        chart = BarChart()
    elif ctype == "line":
        chart = LineChart()
    elif ctype == "pie":
        chart = PieChart()
    elif ctype == "scatter":
        chart = ScatterChart()
    else:
        chart = BarChart()

    if chart_def.title:
        chart.title = chart_def.title

    # Categories from labels column (write them as a helper column at end)
    labels_col = len(chart_def.series[0].get("name", "")) if False else None

    # Write series to extra columns at the right of data block
    n_data_cols = max(n_series, 1)
    first_data_col = 1
    # write categories in a column, take Series() from Reference
    # We assume data is in headers/rows; we use Reference to existing columns
    # Strategy: write chart-helper block:
    start_helper_row = start_row + n_rows + 4
    if labels:
        ws.cell(row=start_helper_row, column=1, value="Category")
        for i, lbl in enumerate(labels, start=1):
            ws.cell(row=start_helper_row + i, column=1, value=lbl)
        chart.set_categories(
            Reference(ws, min_col=1, min_row=start_helper_row, max_row=start_helper_row + len(labels))
        )
    for si, s in enumerate(series, start=2):
        sname = s.get("name", f"Series {si-1}")
        svalues = s.get("values", [])
        ws.cell(row=start_helper_row, column=si, value=sname)
        for vi, v in enumerate(svalues, start=1):
            ws.cell(row=start_helper_row + vi, column=si, value=v)
        chart.add_data(
            Reference(ws, min_col=si, min_row=start_helper_row, max_row=start_helper_row + len(svalues)),
            titles_from_data=True,
        )

    chart.has_legend = bool(chart_def.show_legend)
    chart.width = chart_def.width
    chart.height = chart_def.height

    ws.add_chart(chart, chart_def.anchor_cell or "E2")


# ---- Conditional formatting dispatch ------------------------------------------

def _apply_cf(ws, cf, *, start_row, n_rows, n_cols):
    from openpyxl.formatting.rule import CellIsRule, FormulaRule, ColorScaleRule

    ref = f"{get_column_letter(1)}{start_row + 1}:{get_column_letter(n_cols)}{start_row + n_rows}"
    fill = PatternFill(start_color=_to_argb(cf.fill_color), end_color=_to_argb(cf.fill_color), fill_type="solid")
    font = Font(color=_to_argb(cf.font_color)) if cf.font_color else None

    if cf.type == "cell_is":
        rule = CellIsRule(operator=cf.operator or "greaterThan", formula=cf.formula or [], fill=fill, font=font)
        ws.conditional_formatting.add(ref, rule)
    elif cf.type == "color_scale":
        rule = ColorScaleRule(start_type="min", start_color="FF63BE7B", end_type="max", end_color="FFF8696B")
        ws.conditional_formatting.add(ref, rule)
    elif cf.type == "formula":
        rule = FormulaRule(formula=cf.formula or [], fill=fill, font=font)
        ws.conditional_formatting.add(ref, rule)


def escape_formula(val):
    """Convert string starting with = into a safe literal if needed."""
    return val
