"""DOCX builder using python-docx — professional headings, tables, footers."""

from __future__ import annotations

import base64
import io

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Inches, Cm

from schemas.docx import DocxPayload
from utils.styles import DEFAULT_DOCX_THEME, resolve_theme, strip_hash


def _rgb(color: str | None) -> RGBColor:
    c = strip_hash(color, "0D95A1")
    return RGBColor(int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def _hex(x) -> str:
    return f"{(x or 0) & 0xFF:02X}{(x or 0) & 0xFF:02X}{(x or 0) & 0xFF:02X}"


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


def build_docx(payload: DocxPayload) -> bytes:
    theme = resolve_theme(payload.theme.model_dump(exclude_none=True), DEFAULT_DOCX_THEME)
    doc = Document()

    # Core properties
    cp = doc.core_properties
    cp.author = payload.meta.author or "Task App"
    cp.title = payload.title or payload.meta.title or "Documento"
    if payload.meta.subject:
        cp.subject = payload.meta.subject
    if payload.meta.company:
        cp.category = payload.meta.company

    # Default style (Normal) — set font family + size
    styles = doc.styles
    try:
        normal = styles["Normal"]
        normal.font.name = theme.get("font_family") or "Calibri"
        normal.font.size = Pt(11)
    except Exception:
        pass

    # Page setup
    for section in doc.sections:
        if payload.page.orientation == "landscape":
            new_w, new_h = section.page_height, section.page_width
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width = new_w
            section.page_height = new_h
        if payload.page.margins:
            m = payload.page.margins
            try:
                section.top_margin = Cm(m.get("top", 2.5))
                section.bottom_margin = Cm(m.get("bottom", 2.5))
                section.left_margin = Cm(m.get("left", 2.5))
                section.right_margin = Cm(m.get("right", 2.5))
            except Exception:
                pass

        # Footer with page number (professional footer)
        footer = section.footer
        fp = footer.paragraphs[0]
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        _add_page_field(fp)

    # Title
    if payload.title:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(payload.title)
        run.bold = True
        run.font.size = Pt(26)
        run.font.name = theme.get("font_family") or "Calibri"
        run.font.color.rgb = _rgb(theme.get("primary_color"))

    # Subtitle
    if payload.subtitle:
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = p.add_run(payload.subtitle)
        run.italic = True
        run.font.size = Pt(14)
        run.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
        doc.add_paragraph()  # spacer

    # Sections
    for section_def in payload.sections:
        kind = section_def.type

        if kind == "heading":
            level = max(1, min(int(getattr(section_def, "level", 1) or 1), 6))
            p = doc.add_paragraph()
            p.style = f"Heading {level}"
            if not section_def.text:
                continue
            if p.runs:
                p.runs[0].text = section_def.text
                p.runs[0].font.color.rgb = _rgb(theme.get("primary_color"))
            else:
                run = p.add_run(section_def.text)
                run.font.color.rgb = _rgb(theme.get("primary_color"))

        elif kind == "paragraph":
            p = doc.add_paragraph()
            if section_def.align:
                p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER, "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}[section_def.align]
            run = p.add_run(section_def.text or "")
            run.font.size = Pt(section_def.font_size or 11)
            if section_def.bold:
                run.bold = True
            if section_def.italic:
                run.italic = True
            if section_def.color:
                run.font.color.rgb = _rgb(section_def.color)

        elif kind == "bullets":
            for item in section_def.items:
                p = doc.add_paragraph(style="List Bullet")
                if p.runs:
                    p.runs[0].text = item
                else:
                    p.add_run(item)

        elif kind == "numbered":
            for item in section_def.items:
                p = doc.add_paragraph(style="List Number")
                if p.runs:
                    p.runs[0].text = item
                else:
                    p.add_run(item)

        elif kind == "table":
            headers = section_def.headers or []
            rows = section_def.rows or []
            n_cols = len(headers) if headers else max((len(r) for r in rows), default=1)
            table = doc.add_table(rows=1 + len(rows), cols=n_cols)
            table.style = section_def.style or "Table Grid"
            table.alignment = WD_TABLE_ALIGNMENT.CENTER
            # Header
            for ci, h in enumerate(headers):
                cell = table.rows[0].cells[ci]
                cell.text = str(h)
                _shade_cell(cell, theme.get("primary_color") or "#0D95A1")
                for p in cell.paragraphs:
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    for run in p.runs:
                        run.bold = True
                        run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            # Rows
            for ri, row in enumerate(rows, start=1):
                for ci, val in enumerate(row[:n_cols]):
                    cell = table.rows[ri].cells[ci]
                    cell.text = str(val) if val is not None else ""
                    # banded
                    if ri % 2 == 0:
                        _shade_cell(cell, "#F1F5F9")

        elif kind == "quote":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.left_indent = Cm(1)
            _add_left_border(p, theme.get("primary_color") or "#0D95A1")
            run = p.add_run(section_def.text or "")
            run.italic = True
            run.font.color.rgb = _rgb(theme.get("dark_color") or "#0F172A")
            if section_def.author:
                p.add_run(f"  \u2014 {section_def.author}").italic = True

        elif kind == "code":
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.5)
            _shade_paragraph(p, "#F1F5F9")
            run = p.add_run(section_def.text or "")
            run.font.name = "Courier New"
            run.font.size = Pt(10)

        elif kind == "image":
            img_data = _decode_image(section_def.image_base64, section_def.image_data)
            if img_data:
                p = doc.add_paragraph()
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                run = p.add_run()
                try:
                    run.add_picture(io.BytesIO(img_data), width=Inches(section_def.width or 5) if section_def.width else Inches(5))
                except Exception:
                    run.add_text("[Imagen inválida]")
                if section_def.caption:
                    cap = doc.add_paragraph()
                    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    crun = cap.add_run(section_def.caption)
                    crun.italic = True
                    crun.font.size = Pt(9)
                    crun.font.color.rgb = _rgb("#64748B")

        elif kind == "hyperlink":
            p = doc.add_paragraph()
            _add_hyperlink(p, section_def.text or section_def.url, section_def.url)

        elif kind == "toc":
            p = doc.add_paragraph()
            _add_toc_field(p, section_def.caption)

        elif kind == "divider":
            p = doc.add_paragraph()
            _add_bottom_border(p, "#CBD5E1")

        elif kind == "page_break":
            doc.add_page_break()

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.getvalue()


# ---- OOXML helpers ------------------------------------------------------------

def _shade_cell(cell, color: str):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), strip_hash(color, "0D95A1"))
    tcPr.append(shd)


def _shade_paragraph(paragraph, color: str):
    pPr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), strip_hash(color, "F1F5F9"))
    pPr.append(shd)


def _add_left_border(paragraph, color: str):
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "24")
    left.set(qn("w:space"), "12")
    left.set(qn("w:color"), strip_hash(color, "0D95A1"))
    pBdr.append(left)
    pPr.append(pBdr)


def _add_bottom_border(paragraph, color: str):
    pPr = paragraph._p.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bot = OxmlElement("w:bottom")
    bot.set(qn("w:val"), "single")
    bot.set(qn("w:sz"), "6")
    bot.set(qn("w:space"), "1")
    bot.set(qn("w:color"), strip_hash(color, "CBD5E1"))
    pBdr.append(bot)
    pPr.append(pBdr)


def _add_page_field(paragraph):
    run = paragraph.add_run()
    fldChar1 = OxmlElement("w:fldChar")
    fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText")
    instrText.set(qn("xml:space"), "preserve")
    instrText.text = "PAGE \\* MERGEFORMAT"
    fldChar2 = OxmlElement("w:fldChar")
    fldChar2.set(qn("w:fldCharType"), "end")
    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)


def _add_toc_field(paragraph, caption: str | None):
    if caption:
        run = paragraph.add_run(caption + "\n")
        run.bold = True
    run = paragraph.add_run()
    fldChar1 = OxmlElement("w:fldChar")
    fldChar1.set(qn("w:fldCharType"), "begin")
    instrText = OxmlElement("w:instrText")
    instrText.set(qn("xml:space"), "preserve")
    instrText.text = 'TOC \\o "1-6" \\h \\z \\u'
    fldChar2 = OxmlElement("w:fldChar")
    fldChar2.set(qn("w:fldCharType"), "separate")
    fldChar3 = OxmlElement("w:t")
    fldChar3.text = "Haz clic derecho y 'Actualizar campo' para mostrarlo."
    fldChar4 = OxmlElement("w:fldChar")
    fldChar4.set(qn("w:fldCharType"), "end")
    run._r.append(fldChar1)
    run._r.append(instrText)
    run._r.append(fldChar2)
    run._r.append(fldChar3)
    run._r.append(fldChar4)


def _add_hyperlink(paragraph, text: str, url: str):
    part = paragraph.part
    r_id = part.relate_to(
        url,
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        is_external=True,
    )
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), r_id)
    new_run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "2563EB")
    u = OxmlElement("w:u")
    u.set(qn("w:val"), "single")
    rPr.append(color)
    rPr.append(u)
    new_run.append(rPr)
    t = OxmlElement("w:t")
    t.text = text or url
    new_run.append(t)
    hyperlink.append(new_run)
    paragraph._p.append(hyperlink)
