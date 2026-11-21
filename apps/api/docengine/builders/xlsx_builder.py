"""XLSX builder (openpyxl): tablas de Excel reales, tipos correctos, anchos por
contenido, fila de totales inteligente y gráficos nativos sobre el rango real."""

from __future__ import annotations

import datetime as dt
import io
import re
from dataclasses import dataclass, field
from typing import Any

from openpyxl import Workbook
from openpyxl.chart import AreaChart, BarChart, DoughnutChart, LineChart, PieChart, Reference, ScatterChart, Series
from openpyxl.chart.data_source import AxDataSource, NumData, NumVal, StrData, StrRef, StrVal
from openpyxl.chart.label import DataLabelList
from openpyxl.chart.series import DataPoint
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import column_index_from_string, get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.properties import PageSetupProperties
from openpyxl.worksheet.table import Table, TableStyleInfo

from normalize import first_filled, is_total_label
from schemas.xlsx import XlsxPayload
from utils.styles import DEFAULT_XLSX_THEME, resolve_theme, strip_hash

THIN = Side(border_style="thin", color="FFD1D5DB")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
TOTAL_BORDER = Border(top=Side(border_style="double", color="FF64748B"))
CHART_PALETTE = ["2563EB", "0D9488", "F59E0B", "DC2626", "7C3AED", "DB2777", "65A30D", "0891B2"]
CHART_DATA_SHEET = "_datos_graficos"
_CELL_REF_RE = re.compile(r"^[A-Za-z]{1,3}\d+(:[A-Za-z]{1,3}\d+)?$")
_COL_RE = re.compile(r"^[A-Za-z]{1,3}$")
_ID_HEADER_RE = re.compile(r"^\s*(id|c[oó]digo|cod\.?|n[°º]|nro\.?|n[uú]mero de|dni|cuit|rut|tel[eé]fono|a[nñ]o|year|ejercicio)\b", re.I)


def _argb(color: str | None, default: str = "1E293B") -> str:
    return "FF" + strip_hash(color, default)


def _fill(color: str | None) -> PatternFill:
    return PatternFill(start_color=_argb(color), end_color=_argb(color), fill_type="solid")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _unwrap_cell(value: Any) -> tuple[Any, str | None]:
    if isinstance(value, dict) and "v" in value:
        return value["v"], value.get("fmt")
    if isinstance(value, dict):
        # celdas-objeto del modelo: {"value": 5, "format": "0%"}
        inner = value.get("value", value.get("text"))
        return inner, value.get("format") or value.get("number_format")
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value), None
    return value, None


def _display_len(value: Any, fmt: str | None) -> int:
    if value is None:
        return 0
    if _is_number(value):
        if fmt and "%" in fmt:
            return len(f"{value * 100:,.1f}%")
        return len(f"{value:,.2f}") if isinstance(value, float) else len(f"{value:,}")
    if isinstance(value, (dt.date, dt.datetime)):
        return 16 if isinstance(value, dt.datetime) else 10
    text = str(value)
    if text.startswith("="):
        return 12
    return max((len(line) for line in text.split("\n")), default=0)


_LOCAL_REF = re.compile(r"(?<![A-Za-z0-9_!$.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])")


def _shift_rows(formula: str, offset: int) -> str:
    """Corre las filas de las referencias de la misma hoja.

    El modelo escribe fórmulas como si el encabezado estuviera en la fila 1; el título
    (y su fila en blanco) corren la tabla hacia abajo. No toca textos entre comillas
    ni referencias a otras hojas.
    """
    if not offset or not isinstance(formula, str):
        return formula
    parts = re.split(r'("(?:[^"]|"")*")', formula)
    for i in range(0, len(parts), 2):
        parts[i] = _LOCAL_REF.sub(lambda m: f"{m[1]}{m[2]}{m[3]}{int(m[4]) + offset}", parts[i])
    return "".join(parts)


def _unique_headers(headers: list[Any], n_cols: int) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for i in range(n_cols):
        raw = headers[i] if i < len(headers) else None
        base = str(raw).strip() if raw not in (None, "") else f"Columna {i + 1}"
        name = base
        n = 2
        while name.lower() in seen:
            name = f"{base} ({n})"
            n += 1
        seen.add(name.lower())
        out.append(name)
    return out


def _table_name(sheet_title: str, used: set[str]) -> str:
    base = re.sub(r"[^A-Za-z0-9_]", "_", sheet_title) or "Tabla"
    if not re.match(r"^[A-Za-z_]", base):
        base = "T_" + base
    base = ("Tabla_" + base)[:200]
    name = base
    n = 2
    while name.lower() in used:
        name = f"{base}_{n}"
        n += 1
    used.add(name.lower())
    return name


@dataclass
class SheetContext:
    ws: Any
    headers: list[str]
    header_row: int | None
    first_row: int
    last_row: int
    n_cols: int
    numeric_cols: list[int] = field(default_factory=list)

    def col_for(self, ref: Any) -> int | None:
        """Resuelve una columna por letra ('B'), nombre de encabezado ('Total') o índice 1-based."""
        if isinstance(ref, int):
            return ref if 1 <= ref <= self.n_cols else None
        if not isinstance(ref, str) or not ref.strip():
            return None
        key = ref.strip()
        for i, h in enumerate(self.headers, start=1):
            if h.lower() == key.lower():
                return i
        if _COL_RE.match(key):
            idx = column_index_from_string(key.upper())
            return idx if 1 <= idx <= max(self.n_cols, 1) else None
        return None


class ChartData:
    """Hoja oculta para series con valores explícitos."""

    def __init__(self, wb):
        self.wb = wb
        self.ws = None
        self.next_col = 1

    def block(self, labels: list[Any], series: list[dict[str, Any]]):
        if self.ws is None:
            self.ws = self.wb.create_sheet(CHART_DATA_SHEET)
            self.ws.sheet_state = "hidden"
        c0 = self.next_col
        n = max([len(labels)] + [len(s.get("values") or []) for s in series] + [0])
        self.ws.cell(row=1, column=c0, value="Categoría")
        for i in range(n):
            self.ws.cell(row=2 + i, column=c0, value=labels[i] if i < len(labels) else f"{i + 1}")
        for si, s in enumerate(series, start=1):
            self.ws.cell(row=1, column=c0 + si, value=str(s.get("name") or f"Serie {si}"))
            for i, v in enumerate(s.get("values") or []):
                self.ws.cell(row=2 + i, column=c0 + si, value=_unwrap_cell(v)[0])
        self.next_col = c0 + len(series) + 2
        return self.ws, c0, n


def _default_column_format(ws, col: int, first_row: int, last_row: int, header: str) -> None:
    """Formato consistente para columnas numéricas sin formato explícito."""
    cells = [ws.cell(row=r, column=col) for r in range(first_row, last_row + 1)]
    numbers = [c for c in cells if _is_number(c.value)]
    if not numbers:
        return
    explicit = [c.number_format for c in numbers if c.number_format != "General"]
    if explicit:
        fmt = max(set(explicit), key=explicit.count)
    elif _ID_HEADER_RE.match(header or "") or all(isinstance(c.value, int) and 1900 <= c.value <= 2100 for c in numbers):
        return  # IDs, códigos, años: sin separador de miles
    elif all(float(c.value).is_integer() for c in numbers):
        fmt = "#,##0"
    else:
        fmt = "#,##0.00"
    for c in numbers:
        if c.number_format == "General":
            c.number_format = fmt


def _values(ws, col: int, first_row: int, last_row: int) -> list[Any]:
    return [ws.cell(row=r, column=col).value for r in range(first_row, last_row + 1)]


def _num_cache(values: list[Any]) -> NumData:
    pts = [NumVal(idx=i, v=v) for i, v in enumerate(values) if _is_number(v)]
    return NumData(pt=pts, ptCount=len(values), formatCode="General")


def _str_cache(values: list[Any]) -> StrData:
    return StrData(ptCount=len(values), pt=[StrVal(idx=i, v=str(v)) for i, v in enumerate(values) if v is not None])


def _fill_caches(chart, ctype: str, cats: list[Any], series_values: list[list[Any]], names: list[str]) -> None:
    """Escribe numCache/strCache: los visores que no recalculan (vistas previas,
    conversores) muestran el gráfico igual que Excel."""
    text_cats = any(not _is_number(v) for v in cats if v is not None)
    for i, ser in enumerate(chart.series):
        values = series_values[i] if i < len(series_values) else []
        if ctype == "scatter":
            if ser.yVal is not None and ser.yVal.numRef is not None:
                ser.yVal.numRef.numCache = _num_cache(values)
            if ser.xVal is not None and ser.xVal.numRef is not None:
                ser.xVal.numRef.numCache = _num_cache(cats)
        else:
            if ser.val is not None and ser.val.numRef is not None:
                ser.val.numRef.numCache = _num_cache(values)
            if ser.cat is not None and ser.cat.numRef is not None:
                if text_cats:
                    ser.cat = AxDataSource(strRef=StrRef(f=ser.cat.numRef.f, strCache=_str_cache(cats)))
                else:
                    ser.cat.numRef.numCache = _num_cache(cats)
        if ser.tx is not None and ser.tx.strRef is not None and i < len(names):
            ser.tx.strRef.strCache = _str_cache([names[i]])


def _new_chart(ctype: str, chart_def):
    if ctype == "line":
        chart = LineChart()
    elif ctype == "area":
        chart = AreaChart()
        if chart_def.stacked:
            chart.grouping = "stacked"
    elif ctype == "pie":
        chart = PieChart()
    elif ctype == "doughnut":
        chart = DoughnutChart()
        chart.holeSize = 55
    elif ctype == "scatter":
        chart = ScatterChart()
        chart.style = 13
    else:
        chart = BarChart()
        chart.type = "bar" if chart_def.horizontal else "col"
        chart.gapWidth = 80
        if chart_def.stacked:
            chart.grouping = "stacked"
            chart.overlap = 100
    return chart


def _color_series(chart, ctype: str, n_points: int, palette: list[str]) -> None:
    if ctype in ("pie", "doughnut"):
        if not chart.series:
            return
        s = chart.series[0]
        for i in range(n_points):
            pt = DataPoint(idx=i)
            pt.graphicalProperties.solidFill = palette[i % len(palette)]
            pt.graphicalProperties.line.solidFill = "FFFFFF"
            s.dPt.append(pt)
        return
    for i, s in enumerate(chart.series):
        color = palette[i % len(palette)]
        if ctype in ("line", "scatter"):
            s.graphicalProperties.line.solidFill = color
            s.graphicalProperties.line.width = 28575
            s.smooth = False
            if ctype == "scatter":
                s.marker.symbol = "circle"
                s.marker.size = 7
                s.marker.graphicalProperties.solidFill = color
                s.marker.graphicalProperties.line.solidFill = color
                s.graphicalProperties.line.noFill = True
        else:
            s.graphicalProperties.solidFill = color
            s.graphicalProperties.line.solidFill = color


def _add_chart(ws, chart_def, ctx: SheetContext, chart_data: ChartData, anchor: str, palette: list[str]) -> bool:
    ctype = chart_def.type
    explicit = [s for s in (chart_def.series or []) if s.get("values")]
    chart = _new_chart(ctype, chart_def)
    n_points = 0

    if explicit:
        labels = list(chart_def.labels or [])
        data_ws, c0, n = chart_data.block(labels, explicit)
        if n == 0:
            return False
        n_points = n
        cats = Reference(data_ws, min_col=c0, min_row=2, max_row=1 + n)
        for si in range(1, len(explicit) + 1):
            vals = Reference(data_ws, min_col=c0 + si, min_row=1, max_row=1 + n)
            if ctype == "scatter":
                ser = Series(Reference(data_ws, min_col=c0 + si, min_row=2, max_row=1 + n), cats,
                             title=str(explicit[si - 1].get("name") or f"Serie {si}"))
                chart.series.append(ser)
            else:
                chart.add_data(vals, titles_from_data=True)
        if ctype != "scatter":
            chart.set_categories(cats)
        cat_values = _values(data_ws, c0, 2, 1 + n)
        _fill_caches(chart, ctype, cat_values,
                     [_values(data_ws, c0 + si, 2, 1 + n) for si in range(1, len(explicit) + 1)],
                     [str(explicit[si].get("name") or f"Serie {si + 1}") for si in range(len(explicit))])
    else:
        if ctx.header_row is None or ctx.last_row < ctx.first_row:
            return False
        refs = [ctx.col_for(s.get("column")) for s in (chart_def.series or []) if s.get("column") is not None]
        series_cols = [c for c in refs if c]
        cat_col = ctx.col_for(chart_def.labels_column) if chart_def.labels_column else None
        if cat_col is None:
            text_cols = [c for c in range(1, ctx.n_cols + 1) if c not in ctx.numeric_cols]
            cat_col = text_cols[0] if text_cols else 1
        if not series_cols:
            series_cols = [c for c in ctx.numeric_cols if c != cat_col][:6]
        if not series_cols:
            return False
        if ctype in ("pie", "doughnut"):
            series_cols = series_cols[:1]
        n_points = ctx.last_row - ctx.first_row + 1
        cats = Reference(ws, min_col=cat_col, min_row=ctx.first_row, max_row=ctx.last_row)
        for col in series_cols:
            if ctype == "scatter":
                ser = Series(Reference(ws, min_col=col, min_row=ctx.first_row, max_row=ctx.last_row), cats,
                             title=ctx.headers[col - 1] if col - 1 < len(ctx.headers) else None)
                chart.series.append(ser)
            else:
                chart.add_data(Reference(ws, min_col=col, min_row=ctx.header_row, max_row=ctx.last_row), titles_from_data=True)
        if ctype != "scatter":
            chart.set_categories(cats)
        _fill_caches(chart, ctype, _values(ws, cat_col, ctx.first_row, ctx.last_row),
                     [_values(ws, col, ctx.first_row, ctx.last_row) for col in series_cols],
                     [ctx.headers[col - 1] if col - 1 < len(ctx.headers) else "" for col in series_cols])

    if chart_def.title:
        chart.title = chart_def.title
    if ctype not in ("pie", "doughnut"):
        chart.x_axis.delete = False
        chart.y_axis.delete = False
        horizontal = ctype == "bar" and chart_def.horizontal
        chart.x_axis.axPos = "l" if horizontal else "b"
        chart.y_axis.axPos = "b" if horizontal else "l"
        chart.x_axis.crosses = "autoZero"
        chart.y_axis.crosses = "autoZero"
        if chart_def.x_title:
            chart.x_axis.title = chart_def.x_title
        if chart_def.y_title:
            chart.y_axis.title = chart_def.y_title
        chart.y_axis.majorGridlines = chart.y_axis.majorGridlines  # mantiene líneas guía
    single_series = len(chart.series) <= 1 and ctype not in ("pie", "doughnut")
    if not chart_def.show_legend or single_series:
        chart.legend = None
    else:
        chart.legend.position = "b"
    if chart_def.data_labels or ctype in ("pie", "doughnut"):
        chart.dataLabels = DataLabelList()
        if ctype in ("pie", "doughnut"):
            chart.dataLabels.showPercent = True
        else:
            chart.dataLabels.showVal = True
    _color_series(chart, ctype, n_points, palette)
    chart.width = float(chart_def.width or 16)
    chart.height = float(chart_def.height or 8.5)
    ws.add_chart(chart, chart_def.anchor_cell or anchor)
    return True


def _apply_number_formats(ws, ctx: SheetContext, formats: dict[str, str]) -> None:
    for key, fmt in formats.items():
        col = ctx.col_for(key)
        if col is not None and not _CELL_REF_RE.match(key):
            for r in range(ctx.first_row, ctx.last_row + 1):
                ws.cell(row=r, column=col).number_format = fmt
            continue
        if _CELL_REF_RE.match(key):
            try:
                target = ws[key]
            except Exception:
                continue
            cells = target if isinstance(target, tuple) else (target,)
            for item in cells:
                for c in (item if isinstance(item, tuple) else (item,)):
                    c.number_format = fmt


def _apply_cf(ws, cf, ctx: SheetContext, offset: int = 0) -> None:
    from openpyxl.formatting.rule import CellIsRule, ColorScaleRule, DataBarRule, FormulaRule

    formulas = [_shift_rows(f, offset) for f in (cf.formula or [])]
    if cf.range:
        ref = _shift_rows(cf.range, offset)
    else:
        cols = ctx.numeric_cols or list(range(1, ctx.n_cols + 1))
        ref = f"{get_column_letter(min(cols))}{ctx.first_row}:{get_column_letter(max(cols))}{ctx.last_row}"
    fill = PatternFill(start_color=_argb(cf.fill_color, "FEF3C7"), end_color=_argb(cf.fill_color, "FEF3C7"), fill_type="solid")
    font = Font(color=_argb(cf.font_color)) if cf.font_color else None
    if cf.type == "color_scale":
        ws.conditional_formatting.add(ref, ColorScaleRule(start_type="min", start_color="FFF8696B", mid_type="percentile",
                                                          mid_value=50, mid_color="FFFFEB84", end_type="max", end_color="FF63BE7B"))
    elif cf.type == "data_bar":
        ws.conditional_formatting.add(ref, DataBarRule(start_type="min", end_type="max", color=_argb(cf.fill_color, "2563EB")))
    elif cf.type == "formula":
        ws.conditional_formatting.add(ref, FormulaRule(formula=formulas, fill=fill, font=font))
    else:
        ws.conditional_formatting.add(ref, CellIsRule(operator=cf.operator or "greaterThan", formula=formulas or ["0"], fill=fill, font=font))


def build_xlsx(payload: XlsxPayload) -> bytes:
    theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_XLSX_THEME)
    wb = Workbook()
    wb.properties.creator = payload.creator or "Tasky"
    if payload.company:
        wb.properties.company = payload.company
    chart_data = ChartData(wb)
    table_names: set[str] = set()
    first_ws = wb.active

    for idx, sheet_def in enumerate(payload.sheets):
        local = {**theme, **(sheet_def.styling.model_dump(exclude_none=True) if sheet_def.styling else {})}
        font_family = local.get("font_family") or "Calibri"
        primary = local.get("primary_color") or "#1E293B"
        palette = [strip_hash(local.get("accent_color"), CHART_PALETTE[0])] + [c for c in CHART_PALETTE if c != strip_hash(local.get("accent_color"), "")]
        ws = first_ws if idx == 0 else wb.create_sheet()
        ws.title = (sheet_def.name or f"Hoja {idx + 1}")[:31]
        ws.sheet_view.showGridLines = True
        if sheet_def.tab_color:
            ws.sheet_properties.tabColor = strip_hash(sheet_def.tab_color, "2563EB")

        rows = [list(r) for r in (sheet_def.rows or [])]
        has_headers = bool(sheet_def.headers)
        n_cols = max([len(sheet_def.headers or [])] + [len(r) for r in rows] + [1])
        use_table = bool(sheet_def.as_table and has_headers and rows)
        headers = _unique_headers(sheet_def.headers or [], n_cols) if has_headers else []

        row_cursor = 1
        if sheet_def.title:
            tcell = ws.cell(row=1, column=1, value=sheet_def.title)
            tcell.font = Font(name=font_family, size=14, bold=True, color=_argb(primary))
            ws.row_dimensions[1].height = 22
            row_cursor = 3

        header_row = None
        if has_headers:
            header_row = row_cursor
            header_fill = local.get("header_fill") or primary
            header_font_color = local.get("header_font_color") or "#FFFFFF"
            for ci, h in enumerate(headers, start=1):
                c = ws.cell(row=header_row, column=ci, value=h)
                c.fill = _fill(header_fill)
                c.font = Font(name=font_family, bold=True, color=_argb(header_font_color, "FFFFFF"))
                c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
                c.border = BORDER
            ws.row_dimensions[header_row].height = 20
            row_cursor += 1

        first_row = row_cursor
        row_offset = first_row - (2 if has_headers else 1)
        col_lengths = [(_display_len(headers[i], None) + 2) if i < len(headers) else 0 for i in range(n_cols)]
        numeric_seen = [0] * n_cols
        text_seen = [0] * n_cols
        alt_fill = _fill(local.get("alt_row_fill") or "#F1F5F9")
        for ri, row in enumerate(rows):
            r = first_row + ri
            for ci in range(n_cols):
                raw = row[ci] if ci < len(row) else None
                value, fmt = _unwrap_cell(raw)
                if isinstance(value, str) and value.startswith("="):
                    value = _shift_rows(value, row_offset)
                c = ws.cell(row=r, column=ci + 1, value=value)
                c.font = Font(name=font_family)
                if fmt:
                    c.number_format = fmt
                elif isinstance(value, dt.datetime):
                    c.number_format = "dd/mm/yyyy hh:mm"
                elif isinstance(value, dt.date):
                    c.number_format = "dd/mm/yyyy"
                if _is_number(value):
                    numeric_seen[ci] += 1
                elif value not in (None, "") and not (isinstance(value, str) and value.startswith("=")):
                    text_seen[ci] += 1
                wrap = sheet_def.wrap_text or (isinstance(value, str) and len(value) > 60)
                c.alignment = Alignment(vertical="top" if wrap else "center", wrap_text=wrap)
                if not use_table:
                    c.border = BORDER
                    if ri % 2 == 1:
                        c.fill = alt_fill
                if ri < 500:
                    col_lengths[ci] = max(col_lengths[ci], min(_display_len(value, fmt), 60))
        last_row = first_row + len(rows) - 1
        # Una fila "Total" escrita por el modelo va fuera de la tabla y de los gráficos.
        manual_total = not sheet_def.summary_row and len(rows) > 1 and is_total_label(first_filled(rows[-1]))
        if manual_total:
            last_row -= 1

        numeric_cols = [ci + 1 for ci in range(n_cols) if numeric_seen[ci] and not text_seen[ci]]
        for col in numeric_cols:
            _default_column_format(ws, col, first_row, last_row, headers[col - 1] if col - 1 < len(headers) else "")
        ctx = SheetContext(ws=ws, headers=headers, header_row=header_row, first_row=first_row,
                           last_row=last_row, n_cols=n_cols, numeric_cols=numeric_cols)

        if sheet_def.number_formats:
            _apply_number_formats(ws, ctx, sheet_def.number_formats)

        if use_table:
            ref = f"A{header_row}:{get_column_letter(n_cols)}{last_row}"
            table = Table(displayName=_table_name(ws.title, table_names), ref=ref)
            table.tableStyleInfo = TableStyleInfo(name=sheet_def.table_style or "TableStyleLight1",
                                                  showRowStripes=True, showColumnStripes=False)
            ws.add_table(table)
        elif sheet_def.auto_filter and has_headers and rows:
            ws.auto_filter.ref = f"A{header_row}:{get_column_letter(n_cols)}{last_row}"

        # Anchos
        if sheet_def.column_widths:
            for ci, w in enumerate(sheet_def.column_widths, start=1):
                ws.column_dimensions[get_column_letter(ci)].width = float(w)
        else:
            for ci in range(n_cols):
                ws.column_dimensions[get_column_letter(ci + 1)].width = max(8, min(col_lengths[ci] + 2, 62))

        # Fila de totales (solo columnas numéricas)
        if sheet_def.summary_row and rows:
            sr = last_row + 1
            label_col = next((c for c in range(1, n_cols + 1) if c not in numeric_cols), None)
            func = (sheet_def.summary_row.formula or "SUM").upper()
            total_fill = _fill(sheet_def.summary_row.fill_color) if sheet_def.summary_row.fill_color else _fill("#F1F5F9")
            total_font_color = "FFFFFFFF" if sheet_def.summary_row.fill_color else _argb(primary)
            if label_col:
                lc = ws.cell(row=sr, column=label_col, value=sheet_def.summary_row.label)
                lc.font = Font(name=font_family, bold=True, color=total_font_color)
                lc.fill = total_fill
                lc.border = TOTAL_BORDER
            for col in numeric_cols:
                letter = get_column_letter(col)
                c = ws.cell(row=sr, column=col, value=f"={func}({letter}{first_row}:{letter}{last_row})")
                c.font = Font(name=font_family, bold=True, color=total_font_color)
                c.fill = total_fill
                c.border = TOTAL_BORDER
                c.number_format = ws.cell(row=first_row, column=col).number_format

        if manual_total:
            tr = last_row + 1
            for ci in range(1, n_cols + 1):
                c = ws.cell(row=tr, column=ci)
                c.font = Font(name=font_family, bold=True, color=_argb(primary))
                c.fill = _fill("#F1F5F9")
                c.border = TOTAL_BORDER
                if ci in numeric_cols:
                    c.number_format = ws.cell(row=first_row, column=ci).number_format

        # Congelar paneles
        freeze = sheet_def.freeze
        if freeze is None:
            if header_row is not None and rows:
                ws.freeze_panes = f"A{header_row + 1}"
        elif freeze.top_left_cell:
            ws.freeze_panes = freeze.top_left_cell
        elif freeze.rows or freeze.cols:
            ws.freeze_panes = f"{get_column_letter(freeze.cols + 1)}{freeze.rows + 1}"

        for rng in sheet_def.merge_cells or []:
            try:
                ws.merge_cells(rng)
            except Exception:
                pass

        for cf in sheet_def.conditional_formatting or []:
            try:
                _apply_cf(ws, cf, ctx, row_offset)
            except Exception:
                pass

        for dv in sheet_def.data_validations or []:
            try:
                rule = DataValidation(type=dv.type, operator=dv.operator or "between", formula1=_shift_rows(dv.formula1, row_offset),
                                      formula2=_shift_rows(dv.formula2, row_offset), allow_blank=dv.allow_blank, showErrorMessage=True)
                ws.add_data_validation(rule)
                rule.add(_shift_rows(dv.cells, row_offset))
            except Exception:
                pass

        charts = list(sheet_def.charts or [])
        if sheet_def.chart:
            charts.insert(0, sheet_def.chart)

        ws.page_setup.orientation = "landscape" if (n_cols > 6 or charts) else "portrait"
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        if header_row is not None:
            ws.print_title_rows = f"{header_row}:{header_row}"
        anchor_col = get_column_letter(n_cols + 2)
        anchor_row = header_row or 1
        for chart_def in charts:
            try:
                if _add_chart(ws, chart_def, ctx, chart_data, f"{anchor_col}{anchor_row}", palette):
                    anchor_row += int(float(chart_def.height or 8.5) * 2) + 2
            except Exception as e:  # un gráfico roto no debe tirar el archivo
                ws.cell(row=anchor_row, column=n_cols + 2, value=f"No se pudo crear el gráfico: {e}")
                anchor_row += 2

    wb.active = 0
    for ws in wb.worksheets:
        ws.sheet_view.tabSelected = ws is wb.worksheets[0]
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
