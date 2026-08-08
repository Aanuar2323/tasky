"""XLSX editor — update cells, add rows, merge, freeze on existing workbook."""

from __future__ import annotations

import base64
import io

from openpyxl import load_workbook


def edit_xlsx(file_base64: str, changes: dict) -> bytes:
    raw = base64.b64decode(file_base64)
    wb = load_workbook(io.BytesIO(raw))

    for sheet_change in changes.get("sheets", []):
        name = sheet_change.get("name")
        ws = wb[name] if name else wb.active
        if not ws:
            continue

        for upd in sheet_change.get("update_cells", []):
            cell_ref = upd.get("cell")
            if not cell_ref:
                continue
            cell = ws[cell_ref]
            if "value" in upd:
                v = upd["value"]
                cell.value = (str(v) if isinstance(v, str) and v.startswith("=") else v)
            if "number_format" in upd:
                cell.number_format = upd["number_format"]

        for row in sheet_change.get("add_rows", []):
            ws.append(row)

        for rng in sheet_change.get("add_merges", []):
            try:
                ws.merge_cells(rng)
            except Exception:
                pass

        for rng in sheet_change.get("remove_merges", []):
            try:
                ws.unmerge_cells(rng)
            except Exception:
                pass

        freeze = sheet_change.get("set_freeze")
        if freeze:
            ws.freeze_panes = freeze

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf.getvalue()
