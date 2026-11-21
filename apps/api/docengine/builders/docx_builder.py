"""DOCX builder (python-docx): tipografía consistente, markdown inline, listas
anidadas, tablas legibles, callouts, portada y pie "Página X de Y"."""

from __future__ import annotations

import base64
import datetime as dt
import io
from typing import Any

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Emu, Inches, Pt, RGBColor

from schemas.docx import DocxPayload
from normalize import coerce_cell
from utils.markdown import parse_inline, parse_markdown_blocks, strip_inline
from utils.styles import DEFAULT_DOCX_THEME, resolve_theme, strip_hash

MUTED = "#64748B"
BORDER = "#D1D5DB"
ZEBRA = "#F8FAFC"

CALLOUT_COLORS = {
    "info": ("#EFF6FF", "#2563EB"),
    "warning": ("#FFFBEB", "#D97706"),
    "success": ("#F0FDF4", "#16A34A"),
    "danger": ("#FEF2F2", "#DC2626"),
}

HEADING_SIZES = {1: 18, 2: 15, 3: 13, 4: 12, 5: 11, 6: 11}


def _rgb(color: str | None, default: str = "0D95A1") -> RGBColor:
    c = strip_hash(color, default)
    return RGBColor(int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


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


# ---- Números ---------------------------------------------------------------------------

def _fmt_number(value: Any, locale: str = "es") -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "" if value is None else str(value)
    if isinstance(value, float) and not value.is_integer():
        text = f"{value:,.2f}"
    else:
        text = f"{int(value):,}"
    if locale == "es":
        text = text.replace(",", "\u0001").replace(".", ",").replace("\u0001", ".")
    return text


def _is_numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _looks_numeric(value: Any) -> bool:
    """Número real o texto numérico ("455.000", "25%", "$1,200"); fechas no cuentan."""
    if _is_numeric(value):
        return True
    if not isinstance(value, str) or not value.strip():
        return False
    coerced = coerce_cell(value)
    if isinstance(coerced, dict):
        coerced = coerced.get("v")
    return _is_numeric(coerced)


# ---- OOXML helpers ------------------------------------------------------------------------

def _set_font(run_or_style_font_element, family: str) -> None:
    """Aplica la familia a ascii/hAnsi/eastAsia/cs (evita fuentes mezcladas)."""
    rpr = run_or_style_font_element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(attr), family)
    # Las fuentes del tema tienen prioridad en Word: sin quitarlas, la fuente elegida no se ve.
    for attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        rfonts.attrib.pop(qn(attr), None)


def _shade(element_pr, color: str) -> None:
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), strip_hash(color, "FFFFFF"))
    element_pr.append(shd)


def _shade_cell(cell, color: str) -> None:
    _shade(cell._tc.get_or_add_tcPr(), color)


def _cell_margins(cell, top=60, bottom=60, left=100, right=100) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    mar = OxmlElement("w:tcMar")
    for side, val in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tcPr.append(mar)


def _cell_borders(cell, color: str, left_size: int | None = None) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for side in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{side}")
        size = left_size if (side == "left" and left_size) else 4
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), strip_hash(color, "D1D5DB") if side == "left" or not left_size else "FFFFFF")
        if left_size and side != "left":
            el.set(qn("w:val"), "nil")
        borders.append(el)
    tcPr.append(borders)


def _table_borders(table, color: str) -> None:
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{side}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), "4")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), strip_hash(color, "D1D5DB"))
        borders.append(el)
    tblPr.append(borders)


def _repeat_header(row) -> None:
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trPr.append(el)


def _cant_split(row) -> None:
    trPr = row._tr.get_or_add_trPr()
    trPr.append(OxmlElement("w:cantSplit"))


def _paragraph_border(paragraph, side: str, color: str, size: int = 6, space: int = 4) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = pPr.find(qn("w:pBdr"))
    if pBdr is None:
        pBdr = OxmlElement("w:pBdr")
        pPr.append(pBdr)
    el = OxmlElement(f"w:{side}")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(size))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), strip_hash(color, "CBD5E1"))
    pBdr.append(el)


def _add_field(paragraph, instruction: str, font_size: float | None = None, color: str | None = None) -> None:
    run = paragraph.add_run()
    if font_size:
        run.font.size = Pt(font_size)
    if color:
        run.font.color.rgb = _rgb(color)
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    txt = OxmlElement("w:t")
    txt.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for el in (begin, instr, sep, txt, end):
        run._r.append(el)


def _add_hyperlink(paragraph, text: str, url: str, *, bold=False, italic=False, size: float | None = None) -> None:
    r_id = paragraph.part.relate_to(
        url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    new_run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "2563EB")
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rPr.append(color)
    rPr.append(underline)
    if bold:
        rPr.append(OxmlElement("w:b"))
    if italic:
        rPr.append(OxmlElement("w:i"))
    if size:
        sz = OxmlElement("w:sz")
        sz.set(qn("w:val"), str(int(size * 2)))
        rPr.append(sz)
    new_run.append(rPr)
    t = OxmlElement("w:t")
    t.set(qn("xml:space"), "preserve")
    t.text = text or url
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)


# ---- Texto enriquecido --------------------------------------------------------------------

def _add_rich_text(paragraph, text: str, *, bold=None, italic=None, color: str | None = None,
                   size: float | None = None, mono_font: str = "Consolas") -> None:
    """Agrega runs a partir de markdown inline. `bold`/`italic` fuerzan formato base."""
    for r in parse_inline(text or ""):
        if r["link"]:
            _add_hyperlink(paragraph, r["text"], r["link"], bold=bool(bold or r["bold"]),
                           italic=bool(italic or r["italic"]), size=size)
            continue
        run = paragraph.add_run(r["text"])
        if bold or r["bold"]:
            run.bold = True
        if italic or r["italic"]:
            run.italic = True
        if r["code"]:
            run.font.name = mono_font
            _set_font(run._r, mono_font)
            run.font.size = Pt((size or 11) - 1)
            rpr = run._r.get_or_add_rPr()
            _shade(rpr, "#F1F5F9")
        elif size:
            run.font.size = Pt(size)
        if color:
            run.font.color.rgb = _rgb(color)


# ---- Estilos del documento ----------------------------------------------------------------

def _setup_styles(doc, theme: dict) -> None:
    font = theme.get("font_family") or "Calibri"
    dark = theme.get("dark_color") or "#0F172A"
    primary = theme.get("primary_color") or "#0D95A1"
    styles = doc.styles

    normal = styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(11)
    normal.font.color.rgb = _rgb("#1F2937")
    _set_font(normal.element, font)
    pf = normal.paragraph_format
    pf.space_after = Pt(6)
    pf.line_spacing = 1.15

    for level in range(1, 7):
        try:
            st = styles[f"Heading {level}"]
        except KeyError:
            continue
        st.font.name = font
        _set_font(st.element, font)
        st.font.size = Pt(HEADING_SIZES[level])
        st.font.bold = True
        st.font.italic = False
        st.font.color.rgb = _rgb(primary if level <= 2 else dark)
        st.paragraph_format.space_before = Pt(16 if level == 1 else 12)
        st.paragraph_format.space_after = Pt(6)
        st.paragraph_format.keep_with_next = True

    for name, size, color, bold in (("Title", 24, primary, True), ("Subtitle", 13, MUTED, False)):
        try:
            st = styles[name]
        except KeyError:
            continue
        st.font.name = font
        _set_font(st.element, font)
        st.font.size = Pt(size)
        st.font.bold = bold
        st.font.italic = False
        st.font.color.rgb = _rgb(color)
        ppr = st.element.find(qn("w:pPr"))
        if ppr is not None:
            for border in ppr.findall(qn("w:pBdr")):
                ppr.remove(border)
        st.paragraph_format.space_before = Pt(0)
        st.paragraph_format.space_after = Pt(4)

    for name in ("List Bullet", "List Bullet 2", "List Bullet 3", "List Number", "List Number 2", "List Number 3"):
        try:
            st = styles[name]
        except KeyError:
            continue
        st.paragraph_format.space_after = Pt(3)


# ---- Listas -------------------------------------------------------------------------------

def _style_for(doc, kind: str, level: int) -> str:
    base = "List Bullet" if kind == "bullets" else "List Number"
    name = base if level == 0 else f"{base} {min(level + 1, 3)}"
    try:
        doc.styles[name]
        return name
    except KeyError:
        return base


def _new_num_id(doc, style_name: str) -> int | None:
    """Crea una instancia de numeración nueva (reinicia en 1) basada en el estilo."""
    try:
        style = doc.styles[style_name]
        numbering = doc.part.numbering_part.element
    except (KeyError, NotImplementedError):
        return None
    ppr = style.element.pPr
    if ppr is None or ppr.numPr is None or ppr.numPr.numId is None:
        return None
    base_num_id = ppr.numPr.numId.val
    abstract_id = None
    for num in numbering.findall(qn("w:num")):
        if num.get(qn("w:numId")) == str(base_num_id):
            abstract = num.find(qn("w:abstractNumId"))
            abstract_id = abstract.get(qn("w:val")) if abstract is not None else None
            break
    if abstract_id is None:
        return None
    existing = [int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))]
    new_id = max(existing + [0]) + 1
    num = OxmlElement("w:num")
    num.set(qn("w:numId"), str(new_id))
    abstract_ref = OxmlElement("w:abstractNumId")
    abstract_ref.set(qn("w:val"), abstract_id)
    num.append(abstract_ref)
    override = OxmlElement("w:lvlOverride")
    override.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:startOverride")
    start.set(qn("w:val"), "1")
    override.append(start)
    num.append(override)
    numbering.append(num)
    return new_id


def _apply_num_id(paragraph, num_id: int, ilvl: int = 0) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    num_pr = pPr.get_or_add_numPr()
    num_pr.get_or_add_ilvl().val = ilvl
    num_pr.get_or_add_numId().val = num_id


def _add_list(doc, container, kind: str, items: list[Any], level: int = 0, num_id: int | None = None) -> None:
    if kind == "numbered" and level == 0 and num_id is None:
        num_id = _new_num_id(doc, "List Number")
    for item in items:
        text = item if isinstance(item, str) else getattr(item, "text", None) or (item.get("text") if isinstance(item, dict) else "")
        children = [] if isinstance(item, str) else (getattr(item, "children", None) or (item.get("children") if isinstance(item, dict) else []) or [])
        try:
            p = container.add_paragraph(style=_style_for(doc, kind, level))
        except KeyError:  # plantilla sin estilos de lista
            p = container.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.6 * (level + 1))
            p.add_run("• " if kind == "bullets" else "– ")
        _add_rich_text(p, str(text))
        if kind == "numbered" and level == 0 and num_id is not None:
            _apply_num_id(p, num_id)
        if children:
            _add_list(doc, container, kind if kind == "bullets" else "bullets", list(children), level + 1)


# ---- Tablas -------------------------------------------------------------------------------

def _usable_width_emu(section) -> int:
    return int(section.page_width - section.left_margin - section.right_margin)


def _column_weights(headers: list[str], rows: list[list[Any]], n_cols: int, explicit: list[float] | None) -> list[float]:
    if explicit and len(explicit) >= n_cols and all(w > 0 for w in explicit[:n_cols]):
        return [float(w) for w in explicit[:n_cols]]
    weights = []
    for ci in range(n_cols):
        lengths = [len(strip_inline(str(headers[ci]))) if ci < len(headers) else 0]
        for r in rows[:200]:
            if ci < len(r) and r[ci] is not None:
                lengths.append(len(strip_inline(str(r[ci]))))
        longest = max(lengths) if lengths else 4
        weights.append(max(4, min(longest, 45)))
    return weights


def _add_table(doc, section_def, theme: dict, locale: str) -> None:
    headers = [str(h) for h in (section_def.headers or [])]
    rows = [list(r) for r in (section_def.rows or [])]
    n_cols = len(headers) if headers else max((len(r) for r in rows), default=1)
    if n_cols == 0:
        return
    primary = theme.get("primary_color") or "#0D95A1"
    has_header = bool(headers)
    table = doc.add_table(rows=(1 if has_header else 0) + len(rows), cols=n_cols)
    try:
        table.style = section_def.style or "Table Grid"
    except Exception:
        table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    _table_borders(table, BORDER)

    numeric_cols = set()
    for ci in range(n_cols):
        values = [r[ci] for r in rows if ci < len(r) and r[ci] not in (None, "")]
        if values and all(_looks_numeric(v) for v in values):
            numeric_cols.add(ci)

    widths = _column_weights(headers, rows, n_cols, section_def.column_widths)
    total_w = sum(widths) or 1
    usable = _usable_width_emu(doc.sections[-1])
    col_emus = [int(usable * w / total_w) for w in widths]

    if has_header:
        hdr = table.rows[0]
        _repeat_header(hdr)
        for ci, h in enumerate(headers[:n_cols]):
            cell = hdr.cells[ci]
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.RIGHT if ci in numeric_cols else WD_ALIGN_PARAGRAPH.LEFT
            p.paragraph_format.space_after = Pt(0)
            _add_rich_text(p, h, bold=True, color="#FFFFFF", size=10)
            _shade_cell(cell, primary)
            _cell_margins(cell)

    offset = 1 if has_header else 0
    for ri, row in enumerate(rows):
        tr = table.rows[ri + offset]
        _cant_split(tr)
        for ci in range(n_cols):
            val = row[ci] if ci < len(row) else ""
            cell = tr.cells[ci]
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(0)
            if _is_numeric(val):
                p.add_run(_fmt_number(val, locale)).font.size = Pt(10)
                p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            else:
                _add_rich_text(p, "" if val is None else str(val), size=10)
                if ci in numeric_cols:
                    p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            if ri % 2 == 1:
                _shade_cell(cell, ZEBRA)
            _cell_margins(cell)

    for ci, width in enumerate(col_emus):
        for r in table.rows:
            r.cells[ci].width = Emu(width)

    if section_def.caption:
        cap = doc.add_paragraph()
        cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _add_rich_text(cap, section_def.caption, italic=True, color=MUTED, size=9)
    else:
        spacer = doc.add_paragraph()
        spacer.paragraph_format.space_after = Pt(2)


def _add_callout(doc, section_def, theme: dict) -> None:
    bg, accent = CALLOUT_COLORS.get(section_def.variant, CALLOUT_COLORS["info"])
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.rows[0].cells[0]
    cell.width = Emu(_usable_width_emu(doc.sections[-1]))
    _shade_cell(cell, bg)
    _cell_borders(cell, accent, left_size=24)
    _cell_margins(cell, 120, 120, 200, 160)
    first = cell.paragraphs[0]
    first.paragraph_format.space_after = Pt(2)
    if section_def.title:
        _add_rich_text(first, section_def.title, bold=True, color=accent)
        body = cell.add_paragraph()
    else:
        body = first
    body.paragraph_format.space_after = Pt(0)
    _add_rich_text(body, section_def.text or "")
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


# ---- Portada, encabezado, pie ---------------------------------------------------------------

def _add_title_block(doc, payload: DocxPayload, theme: dict) -> None:
    primary = theme.get("primary_color") or "#0D95A1"
    cover = payload.cover
    if cover:
        cover_meta = cover if isinstance(cover, dict) else {}
        for _ in range(6):
            doc.add_paragraph()
        title = cover_meta.get("title") or payload.title or payload.meta.title or ""
        subtitle = cover_meta.get("subtitle") or payload.subtitle
        p = doc.add_paragraph(style="Title")
        _add_rich_text(p, title, bold=True, color=primary, size=30)
        _paragraph_border(p, "bottom", primary, size=12, space=8)
        if subtitle:
            sp = doc.add_paragraph(style="Subtitle")
            _add_rich_text(sp, subtitle, color=MUTED, size=15)
        for _ in range(8):
            doc.add_paragraph()
        details = [
            cover_meta.get("author") or payload.meta.author,
            cover_meta.get("organization") or cover_meta.get("company") or payload.meta.company,
            cover_meta.get("date") or dt.date.today().strftime("%d/%m/%Y"),
        ]
        for line in [d for d in details if d]:
            dp = doc.add_paragraph()
            dp.paragraph_format.space_after = Pt(2)
            _add_rich_text(dp, str(line), color=MUTED, size=11)
        doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
        return

    if payload.title:
        p = doc.add_paragraph(style="Title")
        p.paragraph_format.space_after = Pt(4)
        _add_rich_text(p, payload.title, bold=True, color=primary, size=24)
    if payload.subtitle:
        sp = doc.add_paragraph(style="Subtitle")
        _add_rich_text(sp, payload.subtitle, color=MUTED, size=13)
    if payload.title or payload.subtitle:
        rule = doc.add_paragraph()
        rule.paragraph_format.space_after = Pt(10)
        _paragraph_border(rule, "bottom", primary, size=8, space=1)


def _setup_header_footer(section, payload: DocxPayload) -> None:
    if payload.header_text:
        hp = section.header.paragraphs[0]
        hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        _add_rich_text(hp, payload.header_text, color=MUTED, size=9)
    fp = section.footer.paragraphs[0]
    if payload.footer_text:
        fp.alignment = WD_ALIGN_PARAGRAPH.LEFT
        _add_rich_text(fp, payload.footer_text, color=MUTED, size=9)
        if payload.show_page_numbers:
            fp.add_run("\t\t")
    else:
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if payload.show_page_numbers:
        label = fp.add_run("Página ")
        label.font.size = Pt(9)
        label.font.color.rgb = _rgb(MUTED)
        _add_field(fp, "PAGE", 9, MUTED)
        of = fp.add_run(" de ")
        of.font.size = Pt(9)
        of.font.color.rgb = _rgb(MUTED)
        _add_field(fp, "NUMPAGES", 9, MUTED)


def _styled_paragraph(doc, text: str, style: str):
    """Párrafo con estilo si existe en el documento (plantillas ajenas pueden no tenerlo)."""
    try:
        return doc.add_paragraph(text, style=style)
    except KeyError:
        p = doc.add_paragraph()
        run = p.add_run(text)
        run.bold = True
        return p


def _render_section(doc, sd, theme: dict, locale: str) -> None:
    primary = theme.get("primary_color") or "#0D95A1"
    dark = theme.get("dark_color") or "#0F172A"
    kind = sd.type

    if kind == "heading":
        level = max(1, min(int(sd.level or 1), 6))
        text = strip_inline(sd.text or "")
        if text:
            doc.add_paragraph(text, style=f"Heading {level}")

    elif kind == "paragraph":
        p = doc.add_paragraph()
        if sd.align:
            p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
                           "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[sd.align]
        _add_rich_text(p, sd.text or "", bold=sd.bold, italic=sd.italic, color=sd.color, size=sd.font_size)

    elif kind in ("bullets", "numbered"):
        _add_list(doc, doc, kind, list(sd.items or []))

    elif kind == "table":
        _add_table(doc, sd, theme, locale)

    elif kind == "quote":
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.8)
        p.paragraph_format.space_before = Pt(6)
        p.paragraph_format.space_after = Pt(10)
        _paragraph_border(p, "left", primary, size=24, space=10)
        _add_rich_text(p, sd.text or "", italic=True, color=dark, size=11.5)
        if sd.author:
            a = p.add_run(f"\n— {sd.author}")
            a.font.size = Pt(10)
            a.font.color.rgb = _rgb(MUTED)

    elif kind == "code":
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.3)
        p.paragraph_format.space_after = Pt(8)
        _shade(p._p.get_or_add_pPr(), "#F1F5F9")
        run = p.add_run(sd.text or "")
        run.font.name = "Consolas"
        _set_font(run._r, "Consolas")
        run.font.size = Pt(9.5)

    elif kind == "image":
        img = _decode_image(sd.image_base64, sd.image_data)
        if img:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            run = p.add_run()
            try:
                run.add_picture(io.BytesIO(img), width=Inches(sd.width or 5.5))
            except Exception:
                run.add_text("[Imagen no válida]")
            if sd.caption:
                cap = doc.add_paragraph()
                cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                _add_rich_text(cap, sd.caption, italic=True, color=MUTED, size=9)

    elif kind == "hyperlink":
        p = doc.add_paragraph()
        _add_hyperlink(p, sd.text or sd.url, sd.url)

    elif kind == "toc":
        if sd.caption:
            _styled_paragraph(doc, strip_inline(sd.caption), "Heading 1")
        p = doc.add_paragraph()
        _add_field(p, 'TOC \\o "1-3" \\h \\z \\u')
        note = p.runs[-1]._r.find(qn("w:t"))
        if note is not None:
            note.text = "Actualizá el índice: clic derecho → Actualizar campo."

    elif kind == "divider":
        p = doc.add_paragraph()
        _paragraph_border(p, "bottom", "#CBD5E1", size=6, space=1)

    elif kind == "page_break":
        doc.add_page_break()

    elif kind == "callout":
        _add_callout(doc, sd, theme)


def render_markdown_into(doc, markdown: str) -> int:
    """Agrega contenido markdown al final de un documento existente. Devuelve bloques agregados."""
    payload = DocxPayload.model_validate({"sections": parse_markdown_blocks(markdown)})
    theme = dict(DEFAULT_DOCX_THEME)
    for sd in payload.sections:
        _render_section(doc, sd, theme, "es")
    return len(payload.sections)


# ---- Builder principal --------------------------------------------------------------------

def build_docx(payload: DocxPayload) -> bytes:
    theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_DOCX_THEME)
    locale = str(getattr(payload, "number_locale", None) or "es").lower()[:2]
    doc = Document()

    cp = doc.core_properties
    cp.author = payload.meta.author or "Tasky"
    cp.title = payload.title or payload.meta.title or "Documento"
    if payload.meta.subject:
        cp.subject = payload.meta.subject
    if payload.meta.company:
        cp.category = payload.meta.company

    _setup_styles(doc, theme)

    for section in doc.sections:
        if payload.page.orientation == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = section.page_height, section.page_width
        margins = payload.page.margins or {}
        section.top_margin = Cm(margins.get("top", 2.2))
        section.bottom_margin = Cm(margins.get("bottom", 2.2))
        section.left_margin = Cm(margins.get("left", 2.4))
        section.right_margin = Cm(margins.get("right", 2.4))
        _setup_header_footer(section, payload)

    _add_title_block(doc, payload, theme)

    for sd in payload.sections:
        _render_section(doc, sd, theme, locale)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()

