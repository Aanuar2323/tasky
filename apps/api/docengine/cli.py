#!/usr/bin/env python3
"""Tasky Doc Engine — CLI.

Contrato:
    python3 cli.py generate <fmt>  < payload.json  > archivo.binario
    python3 cli.py edit     <fmt>  < {file_base64, changes}.json  > out.binario

<fmt> ∈ {docx, xlsx, pptx}.

Stdin  → JSON (payload del formato, o {file_base64, changes} para edit).
Stdout → binario del archivo generado/editado.
Stderr → JSON {"error": "...", "detail": "..."} en fallo.

Exit codes:
    0  OK
    1  error runtime (builder/edición)
    2  uso inválido (args mal)
    3  JSON de stdin inválido
    4  error de validación de schema (422)
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

# Asegurar imports relativos al paquete docengine cuando se ejecuta como script.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from builders.docx_builder import build_docx
from builders.xlsx_builder import build_xlsx
from builders.pptx_builder import build_pptx
from builders.docx_editor import edit_docx
from builders.xlsx_editor import edit_xlsx
from builders.pptx_editor import edit_pptx
from schemas.docx import DocxPayload
from schemas.xlsx import XlsxPayload
from schemas.pptx import PptxPayload
from normalize import format_validation_error, normalize_payload
from pydantic import ValidationError

FORMATS = ("docx", "xlsx", "pptx")


def _die(code: int, error: str, detail: str) -> None:
    sys.stderr.write(json.dumps({"error": error, "detail": detail}) + "\n")
    sys.stderr.flush()
    sys.exit(code)


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        _die(3, "invalid_json", str(e))


def _write_stdout(buf: bytes) -> None:
    sys.stdout.buffer.write(buf)
    sys.stdout.buffer.flush()


def cmd_generate(fmt: str, payload: dict) -> None:
    # Normalización tolerante (alias, markdown, números como texto…) y luego
    # rechazo de payloads vacíos (evita docx/xlsx/pptx en blanco).
    payload, fixes = normalize_payload(fmt, payload)
    _validate_nonempty(fmt, payload)
    try:
        if fmt == "docx":
            data = DocxPayload.model_validate(payload)
            buf = build_docx(data)
        elif fmt == "xlsx":
            data = XlsxPayload.model_validate(payload)
            buf = build_xlsx(data)
        elif fmt == "pptx":
            data = PptxPayload.model_validate(payload)
            buf = build_pptx(data)
        else:
            _die(2, "bad_format", f"unsupported format: {fmt}")
    except ValidationError as e:
        _die(4, "schema_error", format_validation_error(e))
    except Exception as e:
        _die(1, type(e).__name__, str(e))
    _write_stdout(buf)
    if fixes:
        sys.stderr.write(json.dumps({"fixes": fixes}, ensure_ascii=False) + "\n")
        sys.stderr.flush()


def _validate_nonempty(fmt: str, payload: dict) -> None:
    """Rechaza payloads sin contenido real para evitar archivos en blanco."""
    if not isinstance(payload, dict) or not payload:
        _die(4, "empty_payload", f"{fmt}: payload is empty")
    if fmt == "docx":
        sections = payload.get("sections")
        if not sections or not isinstance(sections, list) or len(sections) == 0:
            _die(4, "empty_payload", "docx requires at least one section in 'sections'")
        if not any(_section_has_content(s) for s in sections):
            _die(4, "empty_payload", "docx: all sections are empty (no text/items/rows)")
    elif fmt == "xlsx":
        sheets = payload.get("sheets")
        if not sheets or not isinstance(sheets, list) or len(sheets) == 0:
            _die(4, "empty_payload", "xlsx requires at least one sheet in 'sheets'")
        if not any(_sheet_has_content(s) for s in sheets):
            _die(4, "empty_payload", "xlsx: all sheets are empty (no headers/rows/title)")
    elif fmt == "pptx":
        slides = payload.get("slides")
        if not slides or not isinstance(slides, list) or len(slides) == 0:
            _die(4, "empty_payload", "pptx requires at least one slide in 'slides'")
        if not any(_slide_has_content(s) for s in slides):
            _die(4, "empty_payload", "pptx: all slides are empty (no title/bullets/content)")


def _section_has_content(s) -> bool:
    if not isinstance(s, dict):
        return False
    t = s.get("type")
    if t in ("heading", "paragraph", "quote", "code", "hyperlink", "callout"):
        return bool(s.get("text") or s.get("title"))
    if t in ("bullets", "numbered"):
        items = s.get("items")
        return bool(items) and any(str(i).strip() for i in items)
    if t == "table":
        return bool(s.get("headers") or s.get("rows"))
    if t == "image":
        return bool(s.get("image_base64") or s.get("image_data"))
    if t in ("toc", "divider", "page_break"):
        return True
    return bool(s.get("text") or s.get("items") or s.get("rows"))


def _sheet_has_content(s) -> bool:
    if not isinstance(s, dict):
        return False
    return bool(s.get("headers") or s.get("rows") or s.get("title") or s.get("chart") or s.get("charts"))


def _slide_has_content(s) -> bool:
    if not isinstance(s, dict):
        return False
    return bool(
        s.get("title") or s.get("subtitle") or s.get("bullets")
        or s.get("paragraph") or s.get("text") or s.get("left_column")
        or s.get("right_column") or s.get("headers") or s.get("rows")
        or s.get("image_base64") or s.get("image_data") or s.get("objects")
        or s.get("stats") or s.get("items") or s.get("chart")
    )


def cmd_edit(fmt: str, payload: dict) -> None:
    if "file_base64" not in payload:
        _die(2, "missing_file", "edit requires file_base64")
    file_base64 = payload["file_base64"]
    changes = payload.get("changes") or {}
    try:
        if fmt == "docx":
            buf, stats = edit_docx(file_base64, changes)
        elif fmt == "xlsx":
            buf, stats = edit_xlsx(file_base64, changes)
        elif fmt == "pptx":
            buf, stats = edit_pptx(file_base64, changes)
        else:
            _die(2, "bad_format", f"unsupported format: {fmt}")
    except ValueError as e:
        _die(4, "edit_error", str(e))
    except Exception as e:
        _die(1, type(e).__name__, str(e))
    _write_stdout(buf)
    sys.stderr.write(json.dumps({"stats": stats}, ensure_ascii=False) + "\n")
    sys.stderr.flush()


def main() -> None:
    if len(sys.argv) < 3:
        _die(2, "usage", "cli.py generate|edit <docx|xlsx|pptx>")
    action, fmt = sys.argv[1], sys.argv[2]
    if fmt not in FORMATS:
        _die(2, "bad_format", f"unsupported format: {fmt}")
    payload = _read_stdin_json()
    if action == "generate":
        cmd_generate(fmt, payload)
    elif action == "edit":
        cmd_edit(fmt, payload)
    else:
        _die(2, "bad_action", f"unknown action: {action}")


if __name__ == "__main__":
    main()
