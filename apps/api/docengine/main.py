"""Tasky Doc Engine — FastAPI service.

Endpoints:
    GET  /health
    POST /api/v1/generate/{format}   body=payload dict -> StreamingResponse(binary)
    POST /api/v1/edit/{format}       body={file_base64, changes} -> StreamingResponse(binary)

Runs as co-process inside the same container as Node API (port 8788).
"""

from __future__ import annotations

import base64
import io
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from builders.docx_builder import build_docx
from builders.pptx_builder import build_pptx
from builders.xlsx_builder import build_xlsx
from schemas.docx import DocxPayload
from schemas.pptx import PptxPayload
from schemas.xlsx import XlsxPayload


app = FastAPI(title="Tasky Doc Engine", version="1.0.0")


# ---- Health -------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True}


# ---- Edit payload ------------------------------------------------------------

class EditPayload(BaseModel):
    file_base64: str
    changes: dict


# ---- Generate -----------------------------------------------------------------

FORMAT_TO_MEDIA = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def _stream(buffer: bytes, media_type: str, filename: str | None):
    headers = {}
    if filename:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    out = io.BytesIO(buffer)
    return StreamingResponse(out, media_type=media_type, headers=headers)


@app.post("/api/v1/generate/{format}")
def generate(format: Literal["docx", "xlsx", "pptx"], payload: dict):
    try:
        if format == "docx":
            data = DocxPayload.model_validate(payload)
            buf = build_docx(data)
        elif format == "xlsx":
            data = XlsxPayload.model_validate(payload)
            buf = build_xlsx(data)
        elif format == "pptx":
            data = PptxPayload.model_validate(payload)
            buf = build_pptx(data)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {format}")
        return _stream(buf, FORMAT_TO_MEDIA[format], data.filename)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"{type(e).__name__}: {e}")


# ---- Edit ---------------------------------------------------------------------

@app.post("/api/v1/edit/{format}")
def edit(format: Literal["docx", "xlsx", "pptx"], payload: EditPayload):
    """Edit an existing document: text replacement (docx/pptx) or cell updates (xlsx)."""
    try:
        if format == "xlsx":
            from builders.xlsx_editor import edit_xlsx
            buf = edit_xlsx(payload.file_base64, payload.changes)
        elif format == "docx":
            from builders.docx_editor import edit_docx
            buf = edit_docx(payload.file_base64, payload.changes)
        elif format == "pptx":
            from builders.pptx_editor import edit_pptx
            buf = edit_pptx(payload.file_base64, payload.changes)
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported format: {format}")
        return _stream(buf, FORMAT_TO_MEDIA[format], None)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"edit error: {type(e).__name__}: {e}")
