#!/usr/bin/env python3
"""scripts/clean_empty_generated.py — one-shot.

Lista y (opcionalmente) mueve a .bak los archivos .docx/.xlsx/.pptx
generados por Tasky que tengan 0 chars de contenido en su texto.

Uso:
    python3 scripts/clean_empty_generated.py            # solo listar (dry-run)
    python3 scripts/clean_empty_generated.py --apply     # renombrar a .bak

Cubierto:
    .docx (word/document.xml → w:t nodes)
    .xlsx (xl/sharedStrings.xml + xl/worksheets/sheetN.xml)
    .pptx (ppt/slides/slideN.xml → a:t nodes)

Para otros formatos (.pdf, .png, etc) se ignora (no listado).
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

STORAGE_DEFAULT = Path(__file__).resolve().parent.parent / "storage"


def docx_text_len(z: zipfile.ZipFile) -> int:
    if "word/document.xml" not in z.namelist():
        return 0
    xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    return sum(len(t) for t in re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml))


def xlsx_text_len(z: zipfile.ZipFile) -> int:
    total = 0
    if "xl/sharedStrings.xml" in z.namelist():
        xml = z.read("xl/sharedStrings.xml").decode("utf-8", errors="replace")
        total += sum(len(t) for t in re.findall(r"<t[^>]*>([^<]*)</t>", xml))
    for name in z.namelist():
        if re.match(r"xl/worksheets/sheet\d+\.xml$", name):
            xml = z.read(name).decode("utf-8", errors="replace")
            total += sum(len(t) for t in re.findall(r"<t[^>]*>([^<]*)</t>", xml))
    return total


def pptx_text_len(z: zipfile.ZipFile) -> int:
    total = 0
    for name in z.namelist():
        if re.match(r"ppt/slides/slide\d+\.xml$", name):
            xml = z.read(name).decode("utf-8", errors="replace")
            total += sum(len(t) for t in re.findall(r"<a:t[^>]*>([^<]*)</a:t>", xml))
    return total


def check_file(p: Path) -> tuple[int, str]:
    ext = p.suffix.lower()
    try:
        z = zipfile.ZipFile(p)
        if z.testzip() is not None:
            return -1, "corrupt"
    except Exception as e:
        return -1, f"not_zip:{e}"
    if ext == ".docx":
        return docx_text_len(z), "docx"
    if ext == ".xlsx":
        return xlsx_text_len(z), "xlsx"
    if ext == ".pptx":
        return pptx_text_len(z), "pptx"
    return -1, "ignored"


def main() -> int:
    ap = argparse.ArgumentParser(description="Lista/limpia .docx/.xlsx/.pptx en blanco generados por Tasky.")
    ap.add_argument("--root", default=str(STORAGE_DEFAULT), help="storage root (default: <repo>/storage)")
    ap.add_argument("--apply", action="store_true", help="renombrar a .bak (default: dry-run)")
    args = ap.parse_args()

    root = Path(args.root)
    if not root.exists():
        print(f"ERROR: root no existe: {root}", file=sys.stderr)
        return 2

    print(f"Scanning: {root} ({'APPLY' if args.apply else 'DRY-RUN'})")
    found = 0
    moved = 0

    for p in root.rglob("files/generated/*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in {".docx", ".xlsx", ".pptx"}:
            continue
        if p.name.endswith(".bak"):
            continue
        n_chars, kind = check_file(p)
        if n_chars == 0:
            rel = p.relative_to(root)
            print(f"  EMPTY ({kind}) {rel}")
            found += 1
            if args.apply:
                bak = p.with_suffix(p.suffix + ".bak")
                shutil.move(str(p), str(bak))
                moved += 1
                print(f"    moved → {bak.name}")

    print()
    print(f"Total en blanco encontrados: {found}")
    if args.apply:
        print(f"Movidos a .bak: {moved}")
    else:
        if found:
            print("Re-ejecuta con --apply para mover a .bak")
    return 0


if __name__ == "__main__":
    sys.exit(main())
