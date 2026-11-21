"""Helpers compartidos por los tests del docengine."""

from __future__ import annotations

import sys
from pathlib import Path

DOCENGINE_DIR = Path(__file__).resolve().parent.parent
if str(DOCENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(DOCENGINE_DIR))

import io  # noqa: E402


def _normalized(fmt: str, payload: dict):
    from normalize import normalize_payload

    data, _ = normalize_payload(fmt, payload)
    return data


def build_docx_doc(payload: dict):
    """normalize → validate → build → python-docx Document."""
    from docx import Document

    from builders.docx_builder import build_docx
    from schemas.docx import DocxPayload

    return Document(io.BytesIO(build_docx(DocxPayload.model_validate(_normalized("docx", payload)))))


def build_xlsx_wb(payload: dict):
    from openpyxl import load_workbook

    from builders.xlsx_builder import build_xlsx
    from schemas.xlsx import XlsxPayload

    return load_workbook(io.BytesIO(build_xlsx(XlsxPayload.model_validate(_normalized("xlsx", payload)))))


def build_pptx_prs(payload: dict):
    from pptx import Presentation

    from builders.pptx_builder import build_pptx
    from schemas.pptx import PptxPayload

    return Presentation(io.BytesIO(build_pptx(PptxPayload.model_validate(_normalized("pptx", payload)))))


def build_xlsx_bytes(payload: dict) -> bytes:
    from builders.xlsx_builder import build_xlsx
    from schemas.xlsx import XlsxPayload

    return build_xlsx(XlsxPayload.model_validate(_normalized("xlsx", payload)))


def zip_parts(data: bytes, prefix: str) -> list[str]:
    """Contenido (texto) de las partes del zip cuyo nombre empieza con `prefix`, ordenadas."""
    import zipfile

    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = sorted(n for n in z.namelist() if n.startswith(prefix))
        return [z.read(n).decode("utf-8") for n in names]
