"""PPTX builder using python-pptx — professional layouts, manual drawing."""

from __future__ import annotations

import base64
import io

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn

from schemas.pptx import PptxPayload
from utils.styles import DEFAULT_PPTX_THEME, resolve_theme, strip_hash, hex_to_rgb


# ---- pptx color helper (RGBColor instead of tuple) ----------------------------

def _rgb(color: str | None) -> RGBColor:
    r, g, b = hex_to_rgb(color if color else "#0D95A1")
    return RGBColor(r, g, b)


# ---- Helpers ------------------------------------------------------------------

def _decode_image(image_base64: str | None, image_data: str | None) -> bytes | None:
    raw = image_base64 or image_data
    if not raw:
        return None
    if "," in raw and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        return base64.b64decode(raw)
    except Exception:
        return None


def _add_title_bar(slide, theme: dict):
    """Add a thin accent rectangle on top of the slide."""
    from pptx.util import Emu, Inches
    bar = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Emu(0), Emu(0), slide.part.slide_layout.slide_master.part.slide_size[0], Inches(0.18),
    ) if False else None  # bbox uses Presentation slide_size below; simpler: use slide.background
    # Simpler accent: add a line below title
    return bar


def _add_title_text(slide, text: str, theme: dict, *, top: float = 0.4, height: float = 0.9):
    from pptx.util import Inches, Pt
    box = slide.shapes.add_textbox(Inches(0.6), Inches(top), Inches(12.13), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.text = text
    p.font.size = Pt(28)
    p.font.bold = True
    p.font.name = theme.get("font_family") or "Calibri"
    p.font.color.rgb = _rgb(theme.get("primary_color"))
    return box


def _add_bullets_box(slide, bullets: list[str], theme: dict, *, top: float, height: float = 5.5):
    from pptx.util import Inches, Pt
    box = slide.shapes.add_textbox(Inches(0.6), Inches(top), Inches(12.13), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    for i, b in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = b
        p.font.size = Pt(16)
        p.font.name = theme.get("font_family") or "Calibri"
        p.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
        # Add bullet glyph via XML
        pPr = p._pPr if p._pPr is not None else p._p.get_or_add_pPr()
        buFont = pPr.makeelement(qn("a:buFont"), {"typeface": "Arial"})
        buChar = pPr.makeelement(qn("a:buChar"), {"char": "▪"})
        pPr.append(buFont)
        pPr.append(buChar)
        p.space_after = Pt(8)
    return box


def _add_table(slide, headers, rows, theme, *, top=1.5):
    from pptx.util import Inches, Pt
    n_cols = len(headers or [])
    n_rows = len(rows or []) + 1
    table_shape = slide.shapes.add_table(n_rows, max(n_cols, 1), Inches(0.6), Inches(top), Inches(12.13), Inches(0.4))
    table = table_shape.table
    # Apply theme: header fill + font
    primary = strip_hash(theme.get("primary_color"))
    dark = strip_hash(theme.get("dark_color") or "#0F172A")
    for ci, h in enumerate(headers or []):
        cell = table.cell(0, ci)
        cell.text = str(h)
        cell.fill.solid()
        cell.fill.fore_color.rgb = _rgb(theme.get("primary_color"))
        for p in cell.text_frame.paragraphs:
            p.font.bold = True
            p.font.color.rgb = _rgb("#FFFFFF")
            p.font.size = Pt(12)
            p.font.name = theme.get("font_family") or "Calibri"
    for ri, row in enumerate(rows or [], start=1):
        for ci, val in enumerate(row):
            cell = table.cell(ri, ci)
            cell.text = str(val) if val is not None else ""
            for p in cell.text_frame.paragraphs:
                p.font.size = Pt(11)
                p.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
                p.font.name = theme.get("font_family") or "Calibri"
    return table_shape


def _add_chart(slide, chart_def, theme):
    from pptx.util import Inches, Pt
    ctype = chart_def.type
    labels = chart_def.labels or []
    series = chart_def.series or []
    chart_data = CategoryChartData()
    chart_data.categories = labels
    for s in series:
        chart_data.add_series(s.name, s.values)
    if ctype == "scatter":
        # CategoryChartData doesn't support XY; fall back to column clustered for stability
        chart_type = XL_CHART_TYPE.COLUMN_CLUSTERED
    else:
        chart_type = {
            "bar": XL_CHART_TYPE.COLUMN_CLUSTERED,
            "line": XL_CHART_TYPE.LINE,
            "pie": XL_CHART_TYPE.PIE,
            "scatter": XL_CHART_TYPE.COLUMN_CLUSTERED,
        }[ctype]
    gframe = slide.shapes.add_chart(chart_type, Inches(1), Inches(1.5), Inches(11), Inches(5), chart_data)
    chart = gframe.chart
    if chart_def.title:
        chart.has_title = True
        chart.chart_title.text_frame.text = chart_def.title
        for p in chart.chart_title.text_frame.paragraphs:
            p.font.size = Pt(18)
            p.font.bold = True
            p.font.name = theme.get("font_family") or "Calibri"
    chart.has_legend = bool(chart_def.show_legend)
    # Apply theme colors
    plot = chart.plots[0] if chart.plots else None
    if plot:
        colors = [
            theme.get("primary_color") or "#0D95A1",
            theme.get("secondary_color") or "#067A85",
            theme.get("accent_color") or "#F59E0B",
        ]
        for i in range(len(list(plot.series))):
            series_item = plot.series[i]
            try:
                series_item.format.fill.solid()
                series_item.format.fill.fore_color.rgb = _rgb(colors[i % len(colors)])
            except Exception:
                pass
    return gframe


# ---- Public builder -----------------------------------------------------------

def build_pptx(payload: PptxPayload) -> bytes:
    theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_PPTX_THEME)
    prs = Presentation()
    # Force 16:9
    prs.slide_width = 12192000  # 13.33"
    prs.slide_height = 6858000  # 7.5"

    # Metadata
    if payload.title:
        prs.core_properties.title = payload.title
    if payload.author:
        prs.core_properties.author = payload.author
    else:
        prs.core_properties.author = "Task App"
    if payload.company:
        prs.core_properties.category = payload.company
    if payload.subject:
        prs.core_properties.subject = payload.subject

    blank_layout = prs.slide_layouts[6]

    for slide_def in payload.slides:
        slide = prs.slides.add_slide(blank_layout)
        layout = slide_def.layout

        # Background color (per slide override)
        if getattr(slide_def, "background_color", None):
            _set_background(slide, slide_def.background_color)
        else:
            _set_background(slide, theme.get("background_color") or "#FFFFFF")

        # Notes
        if getattr(slide_def, "notes", None):
            slide.notes_slide.notes_text_frame.text = slide_def.notes

        # slide number
        if getattr(slide_def, "slide_number", None):
            slide.slide_number = True

        # —— layout-specific rendering ——
        if layout == "title":
            slide.shapes.add_textbox(_in(0.8), _in(2.0), _in(11.73), _in(1.5)).text_frame.text = slide_def.title or ""
            _style_title_text(slide.shapes[-1].text_frame, theme, size=40)
            if slide_def.subtitle:
                sub = slide.shapes.add_textbox(_in(0.8), _in(3.8), _in(11.73), _in(0.8))
                sub.text_frame.text = slide_def.subtitle
                _style_title_text(sub.text_frame, theme, size=20, italic=True, color=theme.get("secondary_color"))

        elif layout == "content":
            if slide_def.title:
                _add_title_text(slide, slide_def.title, theme)
                bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, _in(0), _in(1.3), prs.slide_width, _in(0.06))
                bar.fill.solid(); bar.fill.fore_color.rgb = _rgb(theme.get("primary_color"))
            if slide_def.bullets:
                _add_bullets_box(slide, slide_def.bullets, theme, top=1.6, height=5.3)
            elif slide_def.paragraph:
                tb = slide.shapes.add_textbox(_in(0.6), _in(1.6), _in(12.13), _in(5.3))
                tf = tb.text_frame
                tf.word_wrap = True
                tf.text = slide_def.paragraph
                for p in tf.paragraphs:
                    p.font.size = _Pt(16)
                    p.font.name = theme.get("font_family") or "Calibri"
                    p.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")

        elif layout == "two_columns":
            _add_title_text(slide, slide_def.title, theme)
            bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, _in(0), _in(1.3), prs.slide_width, _in(0.06))
            bar.fill.solid(); bar.fill.fore_color.rgb = _rgb(theme.get("primary_color"))
            if slide_def.left_column:
                box_l = slide.shapes.add_textbox(_in(0.6), _in(1.7), _in(5.9), _in(5.2))
                _fill_bullets(box_l.text_frame, slide_def.left_column, theme)
            if slide_def.right_column:
                box_r = slide.shapes.add_textbox(_in(6.83), _in(1.7), _in(5.9), _in(5.2))
                _fill_bullets(box_r.text_frame, slide_def.right_column, theme)

        elif layout in ("image_left", "image_right"):
            _add_title_text(slide, slide_def.title, theme)
            img_data = _decode_image(slide_def.image_base64, slide_def.image_data)
            img_x, txt_x, txt_w = (0.6, 7.0, 5.9) if layout == "image_left" else (6.83, 0.6, 5.9)
            if img_data:
                try:
                    slide.shapes.add_picture(io.BytesIO(img_data), _in(img_x), _in(1.7), width=_in(6))
                except Exception:
                    pass
            if slide_def.bullets:
                box = slide.shapes.add_textbox(_in(txt_x), _in(1.7), _in(txt_w), _in(5.2))
                _fill_bullets(box.text_frame, slide_def.bullets, theme)

        elif layout == "table":
            _add_title_text(slide, slide_def.title, theme)
            _add_table(slide, slide_def.headers, slide_def.rows, theme, top=1.6)

        elif layout == "chart":
            _add_title_text(slide, slide_def.title, theme)
            _add_chart(slide, slide_def.chart, theme)

        elif layout == "quote":
            # Big blockquote-style centered text
            box = slide.shapes.add_textbox(_in(1.5), _in(2.2), _in(10.33), _in(3))
            tf = box.text_frame
            tf.word_wrap = True
            tf.text = f"\u201c{slide_def.text}\u201d"
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            p.font.size = _Pt(28)
            p.font.italic = True
            p.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
            p.font.name = theme.get("font_family") or "Calibri"
            if slide_def.author:
                a = tf.add_paragraph()
                a.text = f"\u2014 {slide_def.author}"
                a.alignment = PP_ALIGN.CENTER
                a.font.size = _Pt(16)
                a.font.color.rgb = _rgb(theme.get("accent_color") or "#F59E0B")

        elif layout == "section_header":
            _set_background(slide, theme.get("primary_color"))
            box = slide.shapes.add_textbox(_in(0.8), _in(2.8), _in(11.73), _in(1.5))
            tf = box.text_frame
            tf.text = slide_def.title or ""
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            p.font.size = _Pt(40)
            p.font.bold = True
            p.font.color.rgb = _rgb("#FFFFFF")
            p.font.name = theme.get("font_family") or "Calibri"

        elif layout == "closing":
            box = slide.shapes.add_textbox(_in(0.8), _in(2.8), _in(11.73), _in(1.2))
            tf = box.text_frame
            tf.text = slide_def.title or ""
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER
            p.font.size = _Pt(40)
            p.font.bold = True
            p.font.color.rgb = _rgb(theme.get("primary_color"))
            p.font.name = theme.get("font_family") or "Calibri"
            if slide_def.subtitle:
                s = tf.add_paragraph()
                s.text = slide_def.subtitle
                s.alignment = PP_ALIGN.CENTER
                s.font.size = _Pt(20)
                s.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
                s.font.name = theme.get("font_family") or "Calibri"

        elif layout == "custom":
            for obj in slide_def.objects:
                _add_custom_object(slide, obj, theme, prs)

    buf = io.BytesIO()
    prs.save(buf)
    buf.seek(0)
    return buf.getvalue()


# ---- Custom object dispatcher -------------------------------------------------

def _add_custom_object(slide, obj, theme, prs):
    from pptx.util import Inches, Pt
    x = obj.x if obj.x is not None else 0.5
    y = obj.y if obj.y is not None else 0.5
    w = obj.w if obj.w is not None else 12
    h = obj.h if obj.h is not None else 1

    if obj.type == "text":
        tb = slide.shapes.add_textbox(_in(x), _in(y), _in(w), _in(h))
        tf = tb.text_frame
        tf.word_wrap = True
        if obj.content:
            tf.text = obj.content
        for p in tf.paragraphs:
            p.font.size = Pt(obj.font_size or 16)
            p.font.bold = bool(obj.bold)
            p.font.name = theme.get("font_family") or "Calibri"
            p.font.color.rgb = _rgb(obj.color or theme.get("dark_color") or "#0F172A")
        return

    if obj.type == "shape":
        shape_type = {
            "rect": MSO_SHAPE.RECTANGLE,
            "round_rect": MSO_SHAPE.ROUNDED_RECTANGLE,
            "ellipse": MSO_SHAPE.OVAL,
            "line": MSO_SHAPE.RECTANGLE,
        }.get(obj.shape, MSO_SHAPE.RECTANGLE)
        shp = slide.shapes.add_shape(shape_type, _in(x), _in(y), _in(w), _in(h))
        if obj.fill:
            shp.fill.solid()
            shp.fill.fore_color.rgb = _rgb(obj.fill)
        return

    if obj.type == "image":
        img_data = _decode_image(obj.image_base64, obj.image_data)
        if img_data:
            try:
                slide.shapes.add_picture(io.BytesIO(img_data), _in(x), _in(y), _in(w) if w else None, _in(h) if h else None)
            except Exception:
                pass
        return

    if obj.type == "chart" and obj.chart:
        _add_chart(slide, obj.chart, theme)
        return

    if obj.type == "table" and obj.table:
        _add_table(slide, obj.table.get("headers"), obj.table.get("rows"), theme, top=y)
        return


# ---- Small private utilities --------------------------------------------------

from pptx.util import Inches as _Inches, Pt as _Pt


def _in(v: float):
    return _Inches(v)


def _style_title_text(tf, theme, *, size=28, italic=False, color=None):
    from pptx.util import Pt
    p = tf.paragraphs[0]
    p.font.size = Pt(size)
    p.font.bold = True
    p.font.name = theme.get("font_family") or "Calibri"
    p.font.italic = italic
    c = color or theme.get("primary_color")
    p.font.color.rgb = _rgb(c if c else "#0D95A1")


def _fill_bullets(tf, bullets, theme):
    from pptx.util import Pt
    for i, b in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = b
        p.font.size = Pt(16)
        p.font.name = theme.get("font_family") or "Calibri"
        p.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
        try:
            pPr = p._p.get_or_add_pPr()
            buFont = pPr.makeelement(qn("a:buFont"), {"typeface": "Arial"})
            buChar = pPr.makeelement(qn("a:buChar"), {"char": "▪"})
            pPr.append(buFont)
            pPr.append(buChar)
            p.space_after = Pt(8)
        except Exception:
            pass


def _set_background(slide, color: str | None):
    if not color:
        return
    try:
        slide.background.fill.solid()
        slide.background.fill.fore_color.rgb = _rgb(color)
    except Exception:
        pass
