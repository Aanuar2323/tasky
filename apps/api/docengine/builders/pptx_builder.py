"""PPTX builder (python-pptx): sistema de layout 16:9 consistente, tipografía
que se adapta al volumen de texto, sub-bullets, KPIs, agenda, tablas partidas y
gráficos nativos (incluido XY real)."""

from __future__ import annotations

import base64
import io
from typing import Any

from pptx import Presentation
from pptx.chart.data import CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_LABEL_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

from normalize import coerce_cell
from schemas.pptx import PptxPayload
from utils.markdown import strip_inline
from utils.styles import DEFAULT_PPTX_THEME, hex_to_rgb, resolve_theme

SLIDE_W = 13.333
SLIDE_H = 7.5
MARGIN_X = 0.75
TITLE_TOP = 0.5
BODY_TOP = 1.75
BODY_BOTTOM = 6.75
TABLE_ROWS_PER_SLIDE = 10
MUTED = "#64748B"


def _rgb(color: str | None, default: str = "#0D95A1") -> RGBColor:
    r, g, b = hex_to_rgb(color or default)
    return RGBColor(r, g, b)


def _luminance(color: str | None) -> float:
    r, g, b = hex_to_rgb(color or "#FFFFFF")
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255


def _decode_image(image_base64: str | None, image_data: str | None) -> bytes | None:
    raw = image_base64 or image_data
    if not raw:
        return None
    if raw.startswith("data:") and "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        return base64.b64decode(raw)
    except Exception:
        return None


def _num(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        c = coerce_cell(value)
        if isinstance(c, dict):
            c = c.get("v")
        if isinstance(c, (int, float)) and not isinstance(c, bool):
            return float(c)
    return None


class Deck:
    """Estado compartido del render: tema, fuentes y numeración."""

    def __init__(self, payload: PptxPayload):
        self.payload = payload
        self.theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_PPTX_THEME)
        self.font = self.theme.get("font_family") or "Calibri"
        self.primary = self.theme.get("primary_color") or "#0D95A1"
        self.secondary = self.theme.get("secondary_color") or "#067A85"
        self.accent = self.theme.get("accent_color") or "#F59E0B"
        self.background = self.theme.get("background_color") or "#FFFFFF"
        self.text = self.theme.get("dark_color") or "#0F172A"
        self.panel = self.theme.get("light_color") or "#F1F5F9"
        dark_bg = _luminance(self.background) < 0.45
        if dark_bg and _luminance(self.text) < 0.45:
            self.text = "#F8FAFC"
        self.muted = "#CBD5E1" if dark_bg else MUTED
        self.palette = [self.primary, self.accent, self.secondary, "#6366F1", "#EC4899", "#10B981", "#F97316", "#0EA5E9"]
        self.prs = Presentation()
        self.prs.slide_width = Inches(SLIDE_W)
        self.prs.slide_height = Inches(SLIDE_H)
        self.blank = self.prs.slide_layouts[6]

    # ---- primitivas -----------------------------------------------------------------

    def new_slide(self, background: str | None = None):
        slide = self.prs.slides.add_slide(self.blank)
        fill = slide.background.fill
        fill.solid()
        fill.fore_color.rgb = _rgb(background or self.background)
        return slide

    def textbox(self, slide, x, y, w, h, *, anchor=MSO_ANCHOR.TOP, wrap=True):
        box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = box.text_frame
        tf.word_wrap = wrap
        tf.vertical_anchor = anchor
        tf.margin_left = tf.margin_right = Inches(0.05)
        tf.margin_top = tf.margin_bottom = Inches(0.03)
        return box, tf

    def style_run(self, run, *, size, bold=False, italic=False, color=None):
        f = run.font
        f.size = Pt(size)
        f.bold = bold
        f.italic = italic
        f.name = self.font
        f.color.rgb = _rgb(color or self.text)

    def write(self, tf, text: str, *, size, bold=False, italic=False, color=None, align=None, first=True, space_after=0):
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        run = p.add_run()
        run.text = strip_inline(text or "")
        self.style_run(run, size=size, bold=bold, italic=italic, color=color)
        if align is not None:
            p.alignment = align
        if space_after:
            p.space_after = Pt(space_after)
        return p

    def rect(self, slide, x, y, w, h, color, shape=MSO_SHAPE.RECTANGLE):
        shp = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
        shp.fill.solid()
        shp.fill.fore_color.rgb = _rgb(color)
        shp.line.fill.background()
        shp.shadow.inherit = False
        return shp

    def title(self, slide, text: str, *, top=TITLE_TOP):
        text = strip_inline(text or "")
        size = 32 if len(text) <= 45 else 28 if len(text) <= 70 else 22
        _, tf = self.textbox(slide, MARGIN_X, top, SLIDE_W - 2 * MARGIN_X, 1.0, anchor=MSO_ANCHOR.BOTTOM)
        self.write(tf, text, size=size, bold=True, color=self.text)
        self.rect(slide, MARGIN_X + 0.05, top + 1.08, 1.1, 0.06, self.primary)

    def bullets(self, tf, items: list[Any], *, base_size: float | None = None, color=None):
        entries = [(it, 0) if isinstance(it, str) else (it.text, max(0, min(4, int(it.level or 0)))) for it in items]
        total_chars = sum(len(t) for t, _ in entries)
        size = base_size or self.fit_size(len(entries), total_chars)
        for i, (text, level) in enumerate(entries):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.level = level
            run = p.add_run()
            run.text = strip_inline(text)
            lvl_size = max(size - 2 * level, 11)
            self.style_run(run, size=lvl_size, color=color)
            p.space_after = Pt(max(4, lvl_size * 0.45) if level == 0 else 3)
            p.line_spacing = 1.05
            self._bullet_glyph(p, level, lvl_size)
        return size

    def _bullet_glyph(self, p, level: int, size: float):
        pPr = p._p.get_or_add_pPr()
        indent = Emu(Inches(0.28 + 0.32 * level))
        pPr.set("marL", str(int(indent)))
        pPr.set("indent", str(-int(Emu(Inches(0.26)))))
        for tag in ("a:buNone", "a:buChar", "a:buFont", "a:buClr", "a:buSzPct"):
            for el in pPr.findall(qn(tag)):
                pPr.remove(el)
        bu_clr = pPr.makeelement(qn("a:buClr"), {})
        srgb = bu_clr.makeelement(qn("a:srgbClr"), {"val": (self.primary if level == 0 else self.muted).lstrip("#").upper()})
        bu_clr.append(srgb)
        pPr.append(bu_clr)
        pPr.append(pPr.makeelement(qn("a:buSzPct"), {"val": "100000"}))
        pPr.append(pPr.makeelement(qn("a:buFont"), {"typeface": "Arial"}))
        pPr.append(pPr.makeelement(qn("a:buChar"), {"char": "•" if level == 0 else "–"}))

    @staticmethod
    def fit_size(count: int, chars: int) -> float:
        if count <= 5 and chars <= 320:
            return 24
        if count <= 7 and chars <= 480:
            return 20
        if count <= 9 and chars <= 700:
            return 18
        if count <= 11 and chars <= 900:
            return 16
        return 14

    def footer(self, slide, number: int):
        # Nombres fijos: los lectores de Tasky los reconocen y no los leen como contenido.
        if self.payload.footer:
            box, tf = self.textbox(slide, MARGIN_X, SLIDE_H - 0.5, 8, 0.3, anchor=MSO_ANCHOR.MIDDLE)
            box.name = "Tasky pie"
            self.write(tf, self.payload.footer, size=11, color=self.muted)
        if self.payload.show_slide_numbers:
            box, tf = self.textbox(slide, SLIDE_W - MARGIN_X - 0.8, SLIDE_H - 0.5, 0.8, 0.3, anchor=MSO_ANCHOR.MIDDLE)
            box.name = "Tasky número de diapositiva"
            self.write(tf, str(number), size=11, color=self.muted, align=PP_ALIGN.RIGHT)

    def notes(self, slide, notes: str | None):
        if notes:
            slide.notes_slide.notes_text_frame.text = notes

    # ---- layouts --------------------------------------------------------------------

    def title_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.rect(slide, 0, 0, 0.32, SLIDE_H, self.primary)
        self.rect(slide, 0.32, 0, 0.08, SLIDE_H, self.accent)
        title = strip_inline(sd.title or self.payload.title or "")
        size = 44 if len(title) <= 40 else 36 if len(title) <= 70 else 30
        _, tf = self.textbox(slide, 1.2, 1.9, SLIDE_W - 2.4, 2.0, anchor=MSO_ANCHOR.BOTTOM)
        self.write(tf, title, size=size, bold=True, color=self.text)
        if sd.subtitle:
            _, st = self.textbox(slide, 1.2, 4.05, SLIDE_W - 2.4, 1.1)
            self.write(st, sd.subtitle, size=22, color=self.muted)
        meta = " · ".join(x for x in (self.payload.author, self.payload.company) if x)
        if meta:
            _, mt = self.textbox(slide, 1.2, SLIDE_H - 1.2, SLIDE_W - 2.4, 0.4)
            self.write(mt, meta, size=14, color=self.muted)
        return slide

    def content_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title)
        top = BODY_TOP
        if sd.paragraph:
            chars = len(sd.paragraph)
            size = 22 if chars < 250 else 18 if chars < 520 else 16 if chars < 800 else 14
            height = (BODY_BOTTOM - top) if not sd.bullets else min(1.6, 0.35 + chars / 110 * 0.4)
            _, tf = self.textbox(slide, MARGIN_X, top, SLIDE_W - 2 * MARGIN_X, height)
            p = self.write(tf, sd.paragraph, size=size, color=self.text)
            p.line_spacing = 1.2
            top += height + 0.15
        if sd.bullets:
            _, tf = self.textbox(slide, MARGIN_X, top, SLIDE_W - 2 * MARGIN_X, BODY_BOTTOM - top)
            tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
            self.bullets(tf, sd.bullets)
        return slide

    def two_columns_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title)
        col_w = (SLIDE_W - 2 * MARGIN_X - 0.4) / 2
        columns = [(sd.left_title, sd.left_column or []), (sd.right_title, sd.right_column or [])]
        all_items = [it for _, items in columns for it in items]
        chars = sum(len(it if isinstance(it, str) else it.text) for it in all_items)
        size = min(self.fit_size(max(len(c[1]) for c in columns), chars // 2), 20)
        for i, (head, items) in enumerate(columns):
            x = MARGIN_X + i * (col_w + 0.4)
            self.rect(slide, x, BODY_TOP, col_w, BODY_BOTTOM - BODY_TOP, self.panel, MSO_SHAPE.ROUNDED_RECTANGLE).adjustments[0] = 0.04
            y = BODY_TOP + 0.25
            if head:
                _, ht = self.textbox(slide, x + 0.3, y, col_w - 0.6, 0.5)
                self.write(ht, head, size=20, bold=True, color=self.primary)
                y += 0.6
            if items:
                _, tf = self.textbox(slide, x + 0.3, y, col_w - 0.6, BODY_BOTTOM - y - 0.2)
                tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
                self.bullets(tf, items, base_size=size)
        return slide

    def image_slide(self, sd, image_left: bool):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title)
        img = _decode_image(sd.image_base64, sd.image_data)
        box_w, box_h = 6.0, BODY_BOTTOM - BODY_TOP
        img_x = MARGIN_X if image_left else SLIDE_W - MARGIN_X - box_w
        txt_x = MARGIN_X + box_w + 0.4 if image_left else MARGIN_X
        if img:
            try:
                pic = slide.shapes.add_picture(io.BytesIO(img), Inches(img_x), Inches(BODY_TOP))
                ratio = min(Inches(box_w) / pic.width, Inches(box_h) / pic.height)
                pic.width, pic.height = int(pic.width * ratio), int(pic.height * ratio)
            except Exception:
                pass
        if sd.bullets:
            _, tf = self.textbox(slide, txt_x, BODY_TOP, SLIDE_W - 2 * MARGIN_X - box_w - 0.4, box_h)
            self.bullets(tf, sd.bullets, base_size=18)
        return slide

    def table_slides(self, sd) -> list:
        headers = [strip_inline(str(h)) for h in (sd.headers or [])]
        rows = [list(r) for r in (sd.rows or [])]
        chunks = [rows[i:i + TABLE_ROWS_PER_SLIDE] for i in range(0, len(rows), TABLE_ROWS_PER_SLIDE)] or [[]]
        n_cols = max([len(headers)] + [len(r) for r in rows] + [1])
        numeric = {ci for ci in range(n_cols)
                   if any(ci < len(r) for r in rows) and all(_num(r[ci]) is not None for r in rows if ci < len(r) and r[ci] not in (None, ""))}
        slides = []
        for idx, chunk in enumerate(chunks):
            slide = self.new_slide(sd.background_color)
            self.title(slide, sd.title if idx == 0 else f"{sd.title} (cont.)")
            n_rows = len(chunk) + (1 if headers else 0)
            font = 16 if n_rows <= 6 and n_cols <= 4 else 14 if n_rows <= 9 and n_cols <= 6 else 12
            row_h = 0.45 if font >= 14 else 0.4
            shape = slide.shapes.add_table(max(n_rows, 1), n_cols, Inches(MARGIN_X), Inches(BODY_TOP),
                                           Inches(SLIDE_W - 2 * MARGIN_X), Inches(row_h * max(n_rows, 1)))
            table = shape.table
            tbl_pr = shape._element.graphic.graphicData.tbl.tblPr
            for attr in ("bandRow", "firstRow"):
                tbl_pr.set(attr, "0")
            r0 = 0
            if headers:
                for ci in range(n_cols):
                    cell = table.cell(0, ci)
                    self._cell(cell, headers[ci] if ci < len(headers) else "", font, bold=True, color="#FFFFFF",
                               fill=self.primary, align=PP_ALIGN.RIGHT if ci in numeric else PP_ALIGN.LEFT)
                r0 = 1
            for ri, row in enumerate(chunk):
                for ci in range(n_cols):
                    val = row[ci] if ci < len(row) else ""
                    self._cell(table.cell(r0 + ri, ci), "" if val is None else str(val), font,
                               fill=self.panel if ri % 2 == 1 else self.background,
                               align=PP_ALIGN.RIGHT if ci in numeric else PP_ALIGN.LEFT)
            slides.append(slide)
        return slides

    def _cell(self, cell, text, size, *, bold=False, color=None, fill=None, align=PP_ALIGN.LEFT):
        cell.text = ""
        tf = cell.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        run = p.add_run()
        run.text = strip_inline(text)
        self.style_run(run, size=size, bold=bold, color=color or self.text)
        p.alignment = align
        cell.margin_left = cell.margin_right = Inches(0.1)
        cell.margin_top = cell.margin_bottom = Inches(0.04)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        if fill:
            cell.fill.solid()
            cell.fill.fore_color.rgb = _rgb(fill)

    def chart_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title)
        self.chart(slide, sd.chart, MARGIN_X, BODY_TOP, SLIDE_W - 2 * MARGIN_X, BODY_BOTTOM - BODY_TOP)
        return slide

    def chart(self, slide, cd, x, y, w, h):
        labels = [strip_inline(str(lbl)) for lbl in (cd.labels or [])]
        series = cd.series or []
        n = max([len(labels)] + [len(s.values) for s in series] + [0])
        if not labels:
            labels = [str(i + 1) for i in range(n)]
        ctype = cd.type
        if ctype == "scatter":
            data = XyChartData()
            xs = [_num(lbl) for lbl in labels]
            if any(v is None for v in xs):
                xs = [float(i + 1) for i in range(len(labels))]
            for s in series:
                ser = data.add_series(s.name)
                for xv, yv in zip(xs, s.values):
                    y_num = _num(yv)
                    if y_num is not None:
                        ser.add_data_point(xv, y_num)
            chart_type = XL_CHART_TYPE.XY_SCATTER
        else:
            data = CategoryChartData()
            data.categories = labels
            for s in (series[:1] if ctype in ("pie", "doughnut") else series):
                data.add_series(s.name, [_num(v) for v in s.values])
            if ctype == "bar":
                if cd.horizontal:
                    chart_type = XL_CHART_TYPE.BAR_STACKED if cd.stacked else XL_CHART_TYPE.BAR_CLUSTERED
                else:
                    chart_type = XL_CHART_TYPE.COLUMN_STACKED if cd.stacked else XL_CHART_TYPE.COLUMN_CLUSTERED
            else:
                chart_type = {
                    "line": XL_CHART_TYPE.LINE_MARKERS,
                    "pie": XL_CHART_TYPE.PIE,
                    "doughnut": XL_CHART_TYPE.DOUGHNUT,
                    "area": XL_CHART_TYPE.AREA_STACKED if cd.stacked else XL_CHART_TYPE.AREA,
                }[ctype]
        frame = slide.shapes.add_chart(chart_type, Inches(x), Inches(y), Inches(w), Inches(h), data)
        chart = frame.chart
        chart.font.name = self.font
        chart.font.size = Pt(13)
        chart.font.color.rgb = _rgb(self.text)
        if cd.title:
            chart.has_title = True
            chart.chart_title.text_frame.text = strip_inline(cd.title)
            for p in chart.chart_title.text_frame.paragraphs:
                for r in p.runs:
                    self.style_run(r, size=16, bold=True)
        else:
            chart.has_title = False
        multi = len(series) > 1 or ctype in ("pie", "doughnut")
        chart.has_legend = bool(cd.show_legend and multi)
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
        plot = chart.plots[0]
        if ctype in ("pie", "doughnut"):
            for i, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = _rgb(self.palette[i % len(self.palette)])
            plot.has_data_labels = True
            plot.data_labels.show_percentage = True
            plot.data_labels.show_value = False
            plot.data_labels.number_format = "0%"
            plot.data_labels.number_format_is_linked = False
            if ctype == "pie":
                plot.data_labels.position = XL_LABEL_POSITION.OUTSIDE_END
        else:
            for i, s in enumerate(plot.series):
                color = _rgb(self.palette[i % len(self.palette)])
                if ctype in ("line", "scatter"):
                    s.format.line.color.rgb = color
                    s.format.line.width = Pt(2.5)
                    s.marker.format.fill.solid()
                    s.marker.format.fill.fore_color.rgb = color
                    if ctype == "scatter":
                        s.format.line.fill.background()
                else:
                    s.format.fill.solid()
                    s.format.fill.fore_color.rgb = color
            if hasattr(plot, "gap_width"):
                plot.gap_width = 80
            if cd.data_labels:
                plot.has_data_labels = True
                plot.data_labels.show_value = True
            try:
                chart.value_axis.has_major_gridlines = True
                chart.value_axis.major_gridlines.format.line.color.rgb = _rgb("#E2E8F0")
                chart.value_axis.format.line.fill.background()
                chart.category_axis.format.line.color.rgb = _rgb("#CBD5E1")
            except Exception:
                pass
        return frame

    def quote_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        _, mark = self.textbox(slide, 1.0, 0.8, 2.0, 2.0)
        self.write(mark, "“", size=140, bold=True, color=self.primary)
        text = strip_inline(sd.text or "")
        size = 32 if len(text) < 120 else 26 if len(text) < 220 else 20
        _, tf = self.textbox(slide, 1.6, 2.2, SLIDE_W - 3.2, 3.2, anchor=MSO_ANCHOR.MIDDLE)
        p = self.write(tf, text, size=size, italic=True, color=self.text)
        p.line_spacing = 1.15
        if sd.author:
            _, at = self.textbox(slide, 1.6, 5.6, SLIDE_W - 3.2, 0.5)
            self.write(at, f"— {sd.author}", size=18, color=self.muted)
        return slide

    def band_slide(self, sd, *, centered: bool):
        slide = self.new_slide(sd.background_color or self.primary)
        on = "#FFFFFF" if _luminance(sd.background_color or self.primary) < 0.6 else self.text
        align = PP_ALIGN.CENTER if centered else PP_ALIGN.LEFT
        x = 1.0 if not centered else MARGIN_X
        w = SLIDE_W - 2 * x
        _, tf = self.textbox(slide, x, 2.5, w, 1.6, anchor=MSO_ANCHOR.BOTTOM)
        self.write(tf, sd.title or "", size=44 if len(sd.title or "") <= 40 else 34, bold=True, color=on, align=align)
        if not centered:
            self.rect(slide, x + 0.05, 4.25, 1.2, 0.07, self.accent)
        if getattr(sd, "subtitle", None):
            _, st = self.textbox(slide, x, 4.5, w, 1.0)
            self.write(st, sd.subtitle, size=22, color=on, align=align)
        return slide

    def stats_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title)
        stats = sd.stats[:8]
        per_row = min(4, len(stats)) or 1
        rows = (len(stats) + per_row - 1) // per_row
        gap = 0.35
        card_w = (SLIDE_W - 2 * MARGIN_X - gap * (per_row - 1)) / per_row
        card_h = min(3.6, (BODY_BOTTOM - BODY_TOP - gap * (rows - 1)) / max(rows, 1))
        for i, st in enumerate(stats):
            r, c = divmod(i, per_row)
            x = MARGIN_X + c * (card_w + gap)
            y = BODY_TOP + r * (card_h + gap)
            card = self.rect(slide, x, y, card_w, card_h, self.panel, MSO_SHAPE.ROUNDED_RECTANGLE)
            card.adjustments[0] = 0.06
            self.rect(slide, x, y + 0.3, 0.08, card_h - 0.6, self.palette[i % len(self.palette)])
            value_size = 48 if len(st.value) <= 6 else 36 if len(st.value) <= 10 else 28
            _, vt = self.textbox(slide, x + 0.35, y + 0.3, card_w - 0.6, card_h * 0.45, anchor=MSO_ANCHOR.BOTTOM)
            self.write(vt, st.value, size=value_size, bold=True, color=self.primary)
            _, lt = self.textbox(slide, x + 0.35, y + 0.35 + card_h * 0.45, card_w - 0.6, card_h * 0.5)
            self.write(lt, st.label, size=16, bold=True, color=self.text, space_after=4)
            if st.detail:
                self.write(lt, st.detail, size=13, color=self.muted, first=False)
        return slide

    def agenda_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        self.title(slide, sd.title or "Agenda")
        items = sd.items[:10]
        two_cols = len(items) > 5
        per_col = (len(items) + 1) // 2 if two_cols else len(items)
        col_w = (SLIDE_W - 2 * MARGIN_X - 0.5) / (2 if two_cols else 1)
        step = min(0.95, (BODY_BOTTOM - BODY_TOP) / max(per_col, 1))
        for i, item in enumerate(items):
            col, row = divmod(i, per_col) if two_cols else (0, i)
            x = MARGIN_X + col * (col_w + 0.5)
            y = BODY_TOP + row * step
            circle = self.rect(slide, x, y, 0.62, 0.62, self.primary, MSO_SHAPE.OVAL)
            ctf = circle.text_frame
            ctf.margin_left = ctf.margin_right = 0
            ctf.vertical_anchor = MSO_ANCHOR.MIDDLE
            self.write(ctf, str(i + 1), size=18, bold=True, color="#FFFFFF", align=PP_ALIGN.CENTER)
            _, tf = self.textbox(slide, x + 0.85, y, col_w - 0.9, 0.62, anchor=MSO_ANCHOR.MIDDLE)
            self.write(tf, item, size=22 if len(item) < 45 else 18, color=self.text)
        return slide

    def custom_slide(self, sd):
        slide = self.new_slide(sd.background_color)
        if sd.title:
            self.title(slide, sd.title)
        for obj in sd.objects:
            x = obj.x if obj.x is not None else MARGIN_X
            y = obj.y if obj.y is not None else BODY_TOP
            w = obj.w if obj.w is not None else SLIDE_W - 2 * MARGIN_X
            h = obj.h if obj.h is not None else 1.0
            try:
                if obj.type == "text":
                    _, tf = self.textbox(slide, x, y, w, h)
                    if obj.bullets:
                        self.bullets(tf, obj.bullets, base_size=obj.font_size or 18, color=obj.color)
                    else:
                        self.write(tf, obj.content or "", size=obj.font_size or 18, bold=bool(obj.bold), color=obj.color)
                elif obj.type == "shape":
                    kind = {"rect": MSO_SHAPE.RECTANGLE, "round_rect": MSO_SHAPE.ROUNDED_RECTANGLE,
                            "ellipse": MSO_SHAPE.OVAL, "line": MSO_SHAPE.RECTANGLE}.get(obj.shape or "rect", MSO_SHAPE.RECTANGLE)
                    shp = self.rect(slide, x, y, w, h if obj.shape != "line" else 0.04, obj.fill or obj.color or self.primary, kind)
                    if obj.content:
                        self.write(shp.text_frame, obj.content, size=obj.font_size or 16, bold=bool(obj.bold), color="#FFFFFF", align=PP_ALIGN.CENTER)
                elif obj.type == "image":
                    img = _decode_image(obj.image_base64, obj.image_data)
                    if img:
                        slide.shapes.add_picture(io.BytesIO(img), Inches(x), Inches(y), Inches(w) if obj.w else None, Inches(h) if obj.h else None)
                elif obj.type == "chart" and obj.chart:
                    self.chart(slide, obj.chart, x, y, w, h if obj.h else 4.5)
                elif obj.type == "table" and obj.table:
                    headers = obj.table.get("headers") or []
                    rows = obj.table.get("rows") or []
                    n_cols = max([len(headers)] + [len(r) for r in rows] + [1])
                    n_rows = len(rows) + (1 if headers else 0)
                    shape = slide.shapes.add_table(max(n_rows, 1), n_cols, Inches(x), Inches(y), Inches(w), Inches(0.4 * max(n_rows, 1)))
                    r0 = 0
                    if headers:
                        for ci, hd in enumerate(headers):
                            self._cell(shape.table.cell(0, ci), str(hd), 13, bold=True, color="#FFFFFF", fill=self.primary)
                        r0 = 1
                    for ri, row in enumerate(rows):
                        for ci, val in enumerate(row[:n_cols]):
                            self._cell(shape.table.cell(r0 + ri, ci), "" if val is None else str(val), 12)
            except Exception:
                continue
        return slide


def build_pptx(payload: PptxPayload) -> bytes:
    deck = Deck(payload)
    prs = deck.prs
    cp = prs.core_properties
    cp.title = payload.title or next((s.title for s in payload.slides if getattr(s, "title", None)), "Presentación")
    cp.author = payload.author or "Tasky"
    if payload.company:
        cp.category = payload.company
    if payload.subject:
        cp.subject = payload.subject

    for sd in payload.slides:
        layout = sd.layout
        if layout == "title":
            made = [deck.title_slide(sd)]
        elif layout == "content":
            made = [deck.content_slide(sd)]
        elif layout == "two_columns":
            made = [deck.two_columns_slide(sd)]
        elif layout in ("image_left", "image_right"):
            made = [deck.image_slide(sd, image_left=layout == "image_left")]
        elif layout == "table":
            made = deck.table_slides(sd)
        elif layout == "chart":
            made = [deck.chart_slide(sd)]
        elif layout == "quote":
            made = [deck.quote_slide(sd)]
        elif layout == "section_header":
            made = [deck.band_slide(sd, centered=False)]
        elif layout == "closing":
            made = [deck.band_slide(sd, centered=True)]
        elif layout == "stats":
            made = [deck.stats_slide(sd)]
        elif layout == "agenda":
            made = [deck.agenda_slide(sd)]
        else:
            made = [deck.custom_slide(sd)]
        for i, slide in enumerate(made):
            deck.notes(slide, getattr(sd, "notes", None))
            if layout not in ("title", "section_header", "closing"):
                deck.footer(slide, len(prs.slides) - len(made) + i + 1)

    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue()
