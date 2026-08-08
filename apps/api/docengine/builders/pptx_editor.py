"""PPTX editor — text replacement in placeholders across all slides."""

from __future__ import annotations

import base64
import io

from pptx import Presentation


def edit_pptx(file_base64: str, changes: dict) -> bytes:
    raw = base64.b64decode(file_base64)
    prs = Presentation(io.BytesIO(raw))

    template = changes.get("template") or {}
    global_replaces = changes.get("replace") or []

    if not isinstance(global_replaces, list):
        global_replaces = []

    for slide in prs.slides:
        for shape in slide.shapes:
            if not shape.has_text_frame:
                continue
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    # placeholder tokens {{key}}
                    if template and ("{" in run.text or "}" in run.text):
                        for key, value in template.items():
                            placeholder = "{{" + key + "}}"
                            if placeholder in run.text:
                                v = "" if value is None else str(value)
                                run.text = run.text.replace(placeholder, v)
                    # global find/replace
                    for r in global_replaces:
                        find = r.get("find")
                        rep = r.get("replace", "")
                        if find and find in run.text:
                            run.text = run.text.replace(find, rep)

    buf = io.BytesIO()
    prs.save(buf)
    buf.seek(0)
    return buf.getvalue()
