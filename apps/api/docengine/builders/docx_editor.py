"""DOCX editor — plantillas `{{clave}}`, reemplazos y anexado de contenido markdown.

Recorre cuerpo, tablas anidadas, encabezados y pies. Devuelve (bytes, stats)."""

from __future__ import annotations

import base64
import io
from typing import Any, Iterator

from docx import Document

from utils.replace import apply_changes


def _table_paragraphs(table) -> Iterator[Any]:
    for row in table.rows:
        for cell in row.cells:
            yield from cell.paragraphs
            for inner in cell.tables:
                yield from _table_paragraphs(inner)


def _container_paragraphs(container) -> Iterator[Any]:
    yield from container.paragraphs
    for table in container.tables:
        yield from _table_paragraphs(table)


def _all_paragraphs(doc) -> Iterator[Any]:
    yield from _container_paragraphs(doc)
    for section in doc.sections:
        for part in (section.header, section.footer, section.first_page_header, section.first_page_footer,
                     section.even_page_header, section.even_page_footer):
            # Un encabezado "vinculado al anterior" no tiene definición propia; acceder
            # a su contenido la crearía vacía, así que se salta.
            if part.is_linked_to_previous:
                continue
            yield from _container_paragraphs(part)


def edit_docx(file_base64: str, changes: dict) -> tuple[bytes, dict]:
    doc = Document(io.BytesIO(base64.b64decode(file_base64)))
    stats: dict[str, Any] = {"replacements": 0, "appended_blocks": 0}

    # Los párrafos de celdas combinadas se repiten al recorrer: dedupe por elemento.
    unique, seen = [], set()
    for p in _all_paragraphs(doc):
        if id(p._p) not in seen:
            seen.add(id(p._p))
            unique.append(p)
    stats["replacements"] = apply_changes((p.runs for p in unique), changes)

    md = changes.get("append_markdown") or changes.get("append")
    if isinstance(md, str) and md.strip():
        from builders.docx_builder import render_markdown_into

        stats["appended_blocks"] = render_markdown_into(doc, md)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue(), stats
