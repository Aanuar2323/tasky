"""Markdown mínimo → estructuras del docengine.

Dos entradas:
  - parse_inline(text): runs con formato inline (negrita, cursiva, código, links).
  - parse_markdown_blocks(text): secciones DOCX (heading, paragraph, bullets,
    numbered, table, code, quote, divider).

No pretende ser CommonMark completo: cubre lo que los modelos escriben en la
práctica y es tolerante a marcadores sin cerrar (quedan como texto literal).
"""

from __future__ import annotations

import re
from typing import Any

Run = dict[str, Any]

_INLINE_RE = re.compile(
    r"(?P<code>`+)(?P<code_body>.+?)(?P=code)"
    r"|\[(?P<link_text>[^\]]+)\]\((?P<link_url>[^)\s]+)(?:\s+\"[^\"]*\")?\)"
    r"|(?P<bi>\*\*\*|___)(?P<bi_body>(?!\s).+?(?<!\s))(?P=bi)"
    r"|(?P<b>\*\*|__)(?P<b_body>(?!\s).+?(?<!\s))(?P=b)"
    r"|(?<![\w*])\*(?P<i_body>(?!\s)[^*]+?(?<!\s))\*(?![\w*])"
    r"|(?<![\w_])_(?P<u_body>(?!\s)[^_]+?(?<!\s))_(?![\w_])"
)


def _run(text: str, *, bold: bool = False, italic: bool = False, code: bool = False, link: str | None = None) -> Run:
    return {"text": text, "bold": bold, "italic": italic, "code": code, "link": link}


def _merge(runs: list[Run]) -> list[Run]:
    merged: list[Run] = []
    for r in runs:
        if not r["text"]:
            continue
        if merged and all(merged[-1][k] == r[k] for k in ("bold", "italic", "code", "link")):
            merged[-1] = {**merged[-1], "text": merged[-1]["text"] + r["text"]}
        else:
            merged.append(r)
    return merged


def _parse(text: str, bold: bool, italic: bool) -> list[Run]:
    runs: list[Run] = []
    pos = 0
    for m in _INLINE_RE.finditer(text):
        if m.start() > pos:
            runs.append(_run(text[pos:m.start()], bold=bold, italic=italic))
        if m.group("code"):
            runs.append(_run(m.group("code_body").strip(), bold=bold, italic=italic, code=True))
        elif m.group("link_text") is not None:
            inner = "".join(r["text"] for r in _parse(m.group("link_text"), False, False))
            runs.append(_run(inner, bold=bold, italic=italic, link=m.group("link_url")))
        elif m.group("bi"):
            runs.extend(_parse(m.group("bi_body"), True, True))
        elif m.group("b"):
            runs.extend(_parse(m.group("b_body"), True, italic))
        elif m.group("i_body") is not None:
            runs.extend(_parse(m.group("i_body"), bold, True))
        elif m.group("u_body") is not None:
            runs.extend(_parse(m.group("u_body"), bold, True))
        pos = m.end()
    if pos < len(text):
        runs.append(_run(text[pos:], bold=bold, italic=italic))
    return runs


def parse_inline(text: str) -> list[Run]:
    """Divide `text` en runs con formato. Siempre devuelve al menos un run si hay texto."""
    if not text:
        return []
    return _merge(_parse(str(text), False, False))


def strip_inline(text: str) -> str:
    """Texto plano sin marcadores inline."""
    return "".join(r["text"] for r in parse_inline(text))


# ---- Bloques ------------------------------------------------------------------

_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_HR_RE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
_FENCE_RE = re.compile(r"^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$")
_BULLET_RE = re.compile(r"^(\s*)([-*+•])\s+(.*)$")
_NUMBER_RE = re.compile(r"^(\s*)(\d{1,3})[.)]\s+(.*)$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _split_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    cells = re.split(r"(?<!\\)\|", s)
    return [c.strip().replace("\\|", "|") for c in cells]


def _list_match(line: str):
    m = _BULLET_RE.match(line)
    if m and not _HR_RE.match(line):
        return "bullets", len(m.group(1)), m.group(3).strip()
    m = _NUMBER_RE.match(line)
    if m:
        return "numbered", len(m.group(1)), m.group(3).strip()
    return None


def _build_tree(entries: list[tuple[int, str]]) -> list[Any]:
    """entries: (indent, text) en orden. Devuelve ítems anidados por indentación:
    str si no tiene hijos, {"text", "children"} si los tiene."""
    root: list[dict[str, Any]] = []
    stack: list[tuple[int, list[dict[str, Any]]]] = [(-1, root)]
    for indent, text in entries:
        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        node: dict[str, Any] = {"text": text, "children": []}
        stack[-1][1].append(node)
        stack.append((indent, node["children"]))
    return _simplify(root)


def _simplify(nodes: list[dict[str, Any]]) -> list[Any]:
    return [
        {"text": n["text"], "children": _simplify(n["children"])} if n["children"] else n["text"]
        for n in nodes
    ]


def parse_markdown_blocks(text: str) -> list[dict[str, Any]]:
    """Convierte markdown en secciones DOCX."""
    if not text or not str(text).strip():
        return []
    lines = str(text).replace("\r\n", "\n").replace("\r", "\n").expandtabs(4).split("\n")
    blocks: list[dict[str, Any]] = []
    para: list[str] = []

    def flush_para() -> None:
        if para:
            joined = ""
            for ln in para:
                if joined and not joined.endswith("\n"):
                    joined += " "
                joined += ln.rstrip() + ("\n" if ln.endswith("  ") else "")
            blocks.append({"type": "paragraph", "text": joined.strip()})
            para.clear()

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            flush_para()
            i += 1
            continue

        fence = _FENCE_RE.match(line)
        if fence:
            flush_para()
            marker = fence.group(1)[:3]
            lang = fence.group(2)
            body: list[str] = []
            i += 1
            while i < n and not lines[i].strip().startswith(marker):
                body.append(lines[i])
                i += 1
            i += 1  # cierre (o fin de texto)
            block: dict[str, Any] = {"type": "code", "text": "\n".join(body).strip("\n")}
            if lang:
                block["language"] = lang
            blocks.append(block)
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            flush_para()
            blocks.append({"type": "heading", "text": heading.group(2).strip(), "level": len(heading.group(1))})
            i += 1
            continue

        if _HR_RE.match(line):
            flush_para()
            blocks.append({"type": "divider"})
            i += 1
            continue

        if "|" in line and i + 1 < n and _TABLE_SEP_RE.match(lines[i + 1]):
            flush_para()
            headers = _split_row(line)
            rows: list[list[str]] = []
            i += 2
            while i < n and lines[i].strip() and "|" in lines[i]:
                rows.append(_split_row(lines[i]))
                i += 1
            blocks.append({"type": "table", "headers": headers, "rows": rows})
            continue

        if stripped.startswith(">"):
            flush_para()
            quote: list[str] = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(re.sub(r"^\s*>\s?", "", lines[i]).strip())
                i += 1
            blocks.append({"type": "quote", "text": " ".join(q for q in quote if q)})
            continue

        lm = _list_match(line)
        if lm:
            flush_para()
            kind, base_indent, first_text = lm
            entries: list[tuple[int, str]] = [(base_indent, first_text)]
            i += 1
            while i < n:
                cur = lines[i]
                if not cur.strip():
                    # lista "suelta": continúa si la próxima línea no vacía es ítem del mismo tipo
                    j = i + 1
                    while j < n and not lines[j].strip():
                        j += 1
                    nxt = _list_match(lines[j]) if j < n else None
                    if nxt and (nxt[0] == kind or nxt[1] > base_indent):
                        i = j
                        continue
                    break
                m2 = _list_match(cur)
                if m2:
                    k2, ind2, t2 = m2
                    if ind2 <= base_indent and k2 != kind:
                        break
                    entries.append((max(ind2, base_indent), t2))
                    i += 1
                    continue
                indent = len(cur) - len(cur.lstrip())
                if indent > base_indent:
                    # línea de continuación del ítem anterior
                    ind, prev = entries[-1]
                    entries[-1] = (ind, f"{prev} {cur.strip()}")
                    i += 1
                    continue
                break
            blocks.append({"type": kind, "items": _build_tree(entries)})
            continue

        para.append(line.strip() if not line.endswith("  ") else line.strip() + "  ")
        i += 1

    flush_para()
    return blocks
