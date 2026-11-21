"""XLSX editor — actualizar celdas, agregar filas/hojas, renombrar, combinar,
congelar y reemplazar texto. Devuelve (bytes, stats)."""

from __future__ import annotations

import base64
import io
from typing import Any

from openpyxl import load_workbook

from normalize import coerce_cell


def _set_value(cell, value: Any) -> None:
    coerced = coerce_cell(value) if isinstance(value, str) else value
    if isinstance(coerced, dict) and "v" in coerced:
        cell.value = coerced["v"]
        cell.number_format = coerced["fmt"]
    else:
        cell.value = coerced


def _last_used_row(ws) -> int:
    for r in range(ws.max_row, 0, -1):
        if any(c.value not in (None, "") for c in ws[r]):
            return r
    return 0


def edit_xlsx(file_base64: str, changes: dict) -> tuple[bytes, dict]:
    wb = load_workbook(io.BytesIO(base64.b64decode(file_base64)))
    stats = {"cells_updated": 0, "rows_added": 0, "sheets_created": 0, "replacements": 0}

    for sheet_change in changes.get("sheets", []) or []:
        name = sheet_change.get("name")
        if name and name not in wb.sheetnames:
            if sheet_change.get("create") or sheet_change.get("add_rows"):
                ws = wb.create_sheet(str(name)[:31])
                stats["sheets_created"] += 1
            else:
                raise ValueError(f"La hoja '{name}' no existe. Hojas disponibles: {', '.join(wb.sheetnames)}")
        else:
            ws = wb[name] if name else wb.active

        for upd in sheet_change.get("update_cells", []) or []:
            ref = upd.get("cell")
            if not ref:
                continue
            cell = ws[ref]
            if "value" in upd:
                _set_value(cell, upd["value"])
                stats["cells_updated"] += 1
            if upd.get("number_format"):
                cell.number_format = upd["number_format"]

        rows = sheet_change.get("add_rows", []) or []
        if rows:
            start = _last_used_row(ws) + 1
            for i, row in enumerate(rows):
                values = row if isinstance(row, (list, tuple)) else [row]
                for ci, value in enumerate(values, start=1):
                    _set_value(ws.cell(row=start + i, column=ci), value)
                stats["rows_added"] += 1

        for rng in sheet_change.get("add_merges", []) or []:
            try:
                ws.merge_cells(rng)
            except Exception:
                pass
        for rng in sheet_change.get("remove_merges", []) or []:
            try:
                ws.unmerge_cells(rng)
            except Exception:
                pass
        if sheet_change.get("set_freeze"):
            ws.freeze_panes = sheet_change["set_freeze"]
        if sheet_change.get("rename"):
            ws.title = str(sheet_change["rename"])[:31]

    replaces = changes.get("replace") or []
    if isinstance(replaces, list):
        for item in replaces:
            find = (item or {}).get("find")
            if not find:
                continue
            repl = "" if item.get("replace") is None else str(item["replace"])
            for ws in wb.worksheets:
                for row in ws.iter_rows():
                    for cell in row:
                        if isinstance(cell.value, str) and find in cell.value and not cell.value.startswith("="):
                            stats["replacements"] += cell.value.count(find)
                            cell.value = cell.value.replace(find, repl)

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue(), stats
