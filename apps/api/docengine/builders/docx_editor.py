"""DOCX editor — paragraph/replacement of `{{placeholder}}` style or text tokens."""

from __future__ import annotations

import base64
import io

from docx import Document


def edit_docx(file_base64: str, changes: dict) -> bytes:
    raw = base64.b64decode(file_base64)
    doc = Document(io.BytesIO(raw))

    template = changes.get("template")
    if template:
        for paragraph in doc.paragraphs:
            for key, value in template.items():
                if isinstance(value, (list, dict)):
                    value_text = str(value)
                else:
                    value_text = str(value) if value is not None else ""
                if "{" in paragraph.text and "}" in paragraph.text and key in paragraph.text:
                    for run in paragraph.runs:
                        if key in run.text:
                            run.text = run.text.replace(key, value_text)
        # tables
        for table in doc.tables:
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        for key, value in template.items():
                            if key in paragraph.text:
                                v = "" if value is None else str(value)
                                for run in paragraph.runs:
                                    if key in run.text:
                                        run.text = run.text.replace(key, v)

    # also support simple global find/replace
    replaces = changes.get("replace", [])
    if isinstance(replaces, list):
        for item in replaces:
            find = item.get("find")
            rep = item.get("replace", "")
            if not find:
                continue
            for paragraph in doc.paragraphs:
                if find in paragraph.text:
                    for run in paragraph.runs:
                        if find in run.text:
                            run.text = run.text.replace(find, rep)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.getvalue()
