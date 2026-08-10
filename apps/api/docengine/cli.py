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
        _die(4, "schema_error", e.json())
    except Exception as e:
        _die(1, type(e).__name__, str(e))
    _write_stdout(buf)


def cmd_edit(fmt: str, payload: dict) -> None:
    if "file_base64" not in payload:
        _die(2, "missing_file", "edit requires file_base64")
    file_base64 = payload["file_base64"]
    changes = payload.get("changes") or {}
    try:
        if fmt == "docx":
            buf = edit_docx(file_base64, changes)
        elif fmt == "xlsx":
            buf = edit_xlsx(file_base64, changes)
        elif fmt == "pptx":
            buf = edit_pptx(file_base64, changes)
        else:
            _die(2, "bad_format", f"unsupported format: {fmt}")
    except Exception as e:
        _die(1, type(e).__name__, str(e))
    _write_stdout(buf)


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
