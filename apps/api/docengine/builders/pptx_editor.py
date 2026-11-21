"""PPTX editor — plantillas `{{clave}}` y reemplazos en cuadros de texto, tablas,
grupos y notas. Devuelve (bytes, stats)."""

from __future__ import annotations

import base64
import io
from typing import Any, Iterator

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

from utils.replace import apply_changes


def _shape_paragraphs(shape) -> Iterator[Any]:
    if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
        for inner in shape.shapes:
            yield from _shape_paragraphs(inner)
        return
    if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
        yield from shape.text_frame.paragraphs
    if getattr(shape, "has_table", False) and shape.has_table:
        for row in shape.table.rows:
            for cell in row.cells:
                yield from cell.text_frame.paragraphs


def edit_pptx(file_base64: str, changes: dict) -> tuple[bytes, dict]:
    prs = Presentation(io.BytesIO(base64.b64decode(file_base64)))
    paragraphs = []
    for slide in prs.slides:
        for shape in slide.shapes:
            paragraphs.extend(_shape_paragraphs(shape))
        if slide.has_notes_slide:
            paragraphs.extend(slide.notes_slide.notes_text_frame.paragraphs)
    stats = {"replacements": apply_changes((list(p.runs) for p in paragraphs), changes)}
    buf = io.BytesIO()
    prs.save(buf)
    return buf.getvalue(), stats
