"""Normalización tolerante de payloads antes de validar con pydantic.

Los modelos de lenguaje producen variaciones previsibles del contrato:
alias de tipos ("h2", "list", "bullets"...), contenido bajo otra clave
("content", "body"), markdown en vez de secciones, filas como objetos,
números como texto ("1.500", "15%", "$1,200.50"), temas con claves cortas.

`normalize_payload(fmt, payload)` corrige lo que tiene una interpretación
inequívoca y deja el resto intacto para que la validación explique el error
(el loop de chat se lo devuelve al modelo para que lo corrija).
"""

from __future__ import annotations

import copy
import datetime as dt
import re
from typing import Any

from utils.markdown import parse_markdown_blocks

Fixes = list[str]

# ---- Colores y temas -------------------------------------------------------------

NAMED_COLORS = {
    "black": "#000000", "negro": "#000000",
    "white": "#FFFFFF", "blanco": "#FFFFFF",
    "red": "#DC2626", "rojo": "#DC2626",
    "green": "#16A34A", "verde": "#16A34A",
    "blue": "#2563EB", "azul": "#2563EB",
    "navy": "#1E3A8A", "marino": "#1E3A8A",
    "teal": "#0D9488", "turquesa": "#0D9488",
    "orange": "#EA580C", "naranja": "#EA580C",
    "purple": "#7C3AED", "violeta": "#7C3AED", "morado": "#7C3AED",
    "yellow": "#CA8A04", "amarillo": "#CA8A04",
    "gray": "#6B7280", "grey": "#6B7280", "gris": "#6B7280",
    "pink": "#DB2777", "rosa": "#DB2777",
}

THEME_PRESETS: dict[str, dict[str, str]] = {
    "corporate": {"primary_color": "#1E3A8A", "secondary_color": "#1D4ED8", "accent_color": "#F59E0B",
                  "background_color": "#FFFFFF", "dark_color": "#0F172A", "light_color": "#F1F5F9"},
    "modern": {"primary_color": "#4F46E5", "secondary_color": "#7C3AED", "accent_color": "#06B6D4",
               "background_color": "#FFFFFF", "dark_color": "#111827", "light_color": "#F5F3FF"},
    "minimal": {"primary_color": "#111827", "secondary_color": "#374151", "accent_color": "#DC2626",
                "background_color": "#FFFFFF", "dark_color": "#111827", "light_color": "#F9FAFB"},
    "dark": {"primary_color": "#38BDF8", "secondary_color": "#818CF8", "accent_color": "#FBBF24",
             "background_color": "#0F172A", "dark_color": "#F8FAFC", "light_color": "#1E293B"},
    "nature": {"primary_color": "#166534", "secondary_color": "#15803D", "accent_color": "#CA8A04",
               "background_color": "#FFFFFF", "dark_color": "#14532D", "light_color": "#F0FDF4"},
    "warm": {"primary_color": "#B45309", "secondary_color": "#C2410C", "accent_color": "#0F766E",
             "background_color": "#FFFBF5", "dark_color": "#292524", "light_color": "#FEF3C7"},
    "teal": {"primary_color": "#0D95A1", "secondary_color": "#067A85", "accent_color": "#F59E0B",
             "background_color": "#FFFFFF", "dark_color": "#0F172A", "light_color": "#F8FBFC"},
}
THEME_PRESETS["corporativo"] = THEME_PRESETS["corporate"]
THEME_PRESETS["moderno"] = THEME_PRESETS["modern"]
THEME_PRESETS["minimalista"] = THEME_PRESETS["minimal"]
THEME_PRESETS["oscuro"] = THEME_PRESETS["dark"]
THEME_PRESETS["naturaleza"] = THEME_PRESETS["nature"]
THEME_PRESETS["calido"] = THEME_PRESETS["warm"]
THEME_PRESETS["cálido"] = THEME_PRESETS["warm"]

THEME_KEY_ALIASES = {
    "primary": "primary_color", "primary_color": "primary_color", "main": "primary_color", "color": "primary_color",
    "secondary": "secondary_color", "secondary_color": "secondary_color",
    "accent": "accent_color", "accent_color": "accent_color",
    "background": "background_color", "background_color": "background_color", "bg": "background_color",
    "dark": "dark_color", "dark_color": "dark_color", "text": "dark_color", "text_color": "dark_color",
    "light": "light_color", "light_color": "light_color",
    "font": "font_family", "font_family": "font_family", "fontfamily": "font_family", "typeface": "font_family",
    "header_fill": "header_fill", "header_font_color": "header_font_color", "alt_row_fill": "alt_row_fill",
}

_HEX_RE = re.compile(r"^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _color(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    v = value.strip()
    if v.lower() in NAMED_COLORS:
        return NAMED_COLORS[v.lower()]
    if _HEX_RE.match(v):
        return v if v.startswith("#") else "#" + v
    m = re.match(r"^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$", v, re.I)
    if m:
        return "#" + "".join(f"{min(255, int(x)):02X}" for x in m.groups())
    return v


def _normalize_theme(theme: Any, fixes: Fixes, allowed: set[str]) -> dict[str, Any]:
    if isinstance(theme, str):
        preset = THEME_PRESETS.get(theme.strip().lower())
        if preset:
            fixes.append(f"theme_preset:{theme.strip().lower()}")
            return {k: v for k, v in preset.items() if k in allowed}
        return {}
    if not isinstance(theme, dict):
        return {}
    out: dict[str, Any] = {}
    preset_name = theme.get("preset") or theme.get("name")
    if isinstance(preset_name, str) and preset_name.strip().lower() in THEME_PRESETS:
        out.update({k: v for k, v in THEME_PRESETS[preset_name.strip().lower()].items() if k in allowed})
    for key, value in theme.items():
        canon = THEME_KEY_ALIASES.get(str(key).strip().lower())
        if canon and canon in allowed and value is not None:
            out[canon] = value if canon == "font_family" else _color(value)
    return out


# ---- Utilidades comunes ---------------------------------------------------------------


def _first(d: dict, *keys: str) -> Any:
    for k in keys:
        if k in d and d[k] not in (None, "", [], {}):
            return d[k]
    return None


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(_as_text(v) for v in value)
    if isinstance(value, dict):
        return _as_text(_first(value, "text", "content", "value", "title", "label"))
    return str(value)


_LIST_MARKER_RE = re.compile(r"^\s*(?:[-*+•▪◦]|\d{1,3}[.)])\s+")
_BLOCK_MD_RE = re.compile(r"^\s{0,3}(#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>\s?|\|.*\||```)", re.M)


def _looks_like_block_markdown(text: str) -> bool:
    return "\n" in text and bool(_BLOCK_MD_RE.search(text))


def _split_lines_items(text: str) -> list[str]:
    items = []
    for line in str(text).replace("\r", "").split("\n"):
        clean = _LIST_MARKER_RE.sub("", line).strip()
        if clean:
            items.append(clean)
    return items


def _markdown_list_items(text: str) -> list[Any]:
    """Ítems anidados desde un string con marcadores de lista, o líneas simples."""
    if _BLOCK_MD_RE.search(text):
        blocks = parse_markdown_blocks(text)
        if blocks and blocks[0]["type"] in ("bullets", "numbered") and len(blocks) == 1:
            return blocks[0]["items"]
    return _split_lines_items(text)


def _norm_items(items: Any) -> list[Any]:
    """Ítems de lista → str | {"text", "children"}."""
    if items is None:
        return []
    if isinstance(items, str):
        return _markdown_list_items(items)
    if isinstance(items, dict):
        items = [items]
    out: list[Any] = []
    for it in items:
        if isinstance(it, dict):
            text = _as_text(_first(it, "text", "content", "title", "label", "value", "item", "name"))
            children = _norm_items(_first(it, "children", "subitems", "sub_items", "items", "bullets", "points"))
            if children:
                out.append({"text": text, "children": children})
            elif text:
                out.append(text)
        elif isinstance(it, (list, tuple)):
            out.extend(_norm_items(list(it)))
        elif it is not None and str(it).strip():
            out.append(_LIST_MARKER_RE.sub("", str(it)).strip())
    return out


def _rows_from_objects(rows: list[Any]) -> tuple[list[str], list[list[Any]]]:
    headers: list[str] = []
    for r in rows:
        if isinstance(r, dict):
            for k in r.keys():
                if k not in headers:
                    headers.append(k)
    return headers, [[r.get(h) if isinstance(r, dict) else r for h in headers] for r in rows]


def _norm_table(headers: Any, rows: Any) -> tuple[list[Any] | None, list[list[Any]] | None]:
    if isinstance(rows, dict):
        rows = [rows]
    if isinstance(rows, list) and rows and all(isinstance(r, dict) for r in rows):
        obj_headers, values = _rows_from_objects(rows)
        return (headers if isinstance(headers, list) and headers else obj_headers), values
    if isinstance(rows, list):
        rows = [list(r) if isinstance(r, (list, tuple)) else [r] for r in rows]
    if isinstance(headers, str):
        headers = [h.strip() for h in re.split(r"[|,;\t]", headers) if h.strip()]
    return headers, rows


def _unwrap(payload: Any, fixes: Fixes, content_keys: tuple[str, ...]) -> dict:
    if not isinstance(payload, dict):
        return {}
    p = copy.deepcopy(payload)
    inner = p.get("data")
    if isinstance(inner, dict) and not any(k in p for k in content_keys):
        merged = {k: v for k, v in p.items() if k != "data"}
        merged.update(inner)
        fixes.append("unwrapped_data")
        return merged
    return p


# ---- DOCX -----------------------------------------------------------------------------

DOCX_TYPE_ALIASES = {
    "heading": "heading", "header": "heading", "title": "heading", "h": "heading", "titulo": "heading",
    "título": "heading", "encabezado": "heading", "section": "heading", "subtitle": "heading", "subtitulo": "heading",
    "subtítulo": "heading",
    "paragraph": "paragraph", "text": "paragraph", "p": "paragraph", "para": "paragraph", "body": "paragraph",
    "parrafo": "paragraph", "párrafo": "paragraph", "texto": "paragraph", "content": "paragraph",
    "bullets": "bullets", "bullet": "bullets", "list": "bullets", "ul": "bullets", "unordered_list": "bullets",
    "bullet_list": "bullets", "bulleted_list": "bullets", "lista": "bullets", "viñetas": "bullets", "items": "bullets",
    "numbered": "numbered", "ol": "numbered", "ordered_list": "numbered", "numbered_list": "numbered",
    "numbers": "numbered", "lista_numerada": "numbered", "steps": "numbered", "pasos": "numbered",
    "table": "table", "tabla": "table", "grid": "table",
    "quote": "quote", "blockquote": "quote", "cita": "quote",
    "code": "code", "codeblock": "code", "code_block": "code", "pre": "code", "codigo": "code", "código": "code",
    "image": "image", "img": "image", "picture": "image", "imagen": "image",
    "hyperlink": "hyperlink", "link": "hyperlink", "url": "hyperlink", "enlace": "hyperlink",
    "toc": "toc", "table_of_contents": "toc", "indice": "toc", "índice": "toc", "contents": "toc",
    "divider": "divider", "hr": "divider", "separator": "divider", "rule": "divider", "line": "divider",
    "separador": "divider",
    "page_break": "page_break", "pagebreak": "page_break", "break": "page_break", "new_page": "page_break",
    "salto": "page_break", "salto_de_pagina": "page_break",
    "callout": "callout", "note": "callout", "nota": "callout", "alert": "callout", "warning": "callout",
    "info": "callout", "tip": "callout", "important": "callout", "aviso": "callout", "admonition": "callout",
    "success": "callout", "danger": "callout", "error": "callout", "advertencia": "callout", "consejo": "callout",
    "markdown": "markdown", "md": "markdown",
}
CALLOUT_VARIANTS = {
    "warning": "warning", "advertencia": "warning", "aviso": "warning", "caution": "warning", "atencion": "warning",
    "info": "info", "note": "info", "nota": "info", "information": "info", "callout": "info", "admonition": "info",
    "tip": "success", "success": "success", "consejo": "success", "ok": "success", "exito": "success",
    "important": "danger", "danger": "danger", "error": "danger", "critical": "danger", "alert": "danger",
    "importante": "danger",
}


def _docx_section(raw: Any, fixes: Fixes) -> list[dict[str, Any]]:
    """Normaliza una sección; puede expandirse en varias (markdown)."""
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        if _looks_like_block_markdown(text) or text.startswith("#"):
            return parse_markdown_blocks(text)
        return [{"type": "paragraph", "text": text}]
    if not isinstance(raw, dict):
        return []

    s = dict(raw)
    raw_type = str(_first(s, "type", "kind", "block", "element") or "").strip().lower()
    heading_level = None
    if re.fullmatch(r"h[1-6]", raw_type):
        heading_level = int(raw_type[1])
        kind = "heading"
    else:
        kind = DOCX_TYPE_ALIASES.get(raw_type.replace("-", "_").replace(" ", "_"), "")

    if not kind:
        if raw_type and raw_type not in DOCX_TYPE_ALIASES:
            if not _first(s, "text", "content", "items", "rows", "headers", "markdown"):
                fixes.append(f"docx_section_dropped:{raw_type}")
                return []
        if _first(s, "markdown"):
            kind = "markdown"
        elif _first(s, "items", "bullets", "points"):
            kind = "bullets"
        elif _first(s, "headers", "rows", "columns"):
            kind = "table"
        elif _first(s, "image_base64", "image_data"):
            kind = "image"
        elif _first(s, "url", "href") and _first(s, "text", "label"):
            kind = "hyperlink"
        elif s.get("level") is not None and _first(s, "text", "title"):
            kind = "heading"
        elif _first(s, "text", "content", "value", "body"):
            kind = "paragraph"
        else:
            fixes.append(f"docx_section_dropped:{raw_type or 'empty'}")
            return []

    if kind == "markdown":
        fixes.append("docx_markdown_section_converted")
        return parse_markdown_blocks(_as_text(_first(s, "markdown", "text", "content")))

    if kind == "heading":
        text = _as_text(_first(s, "text", "title", "content", "heading", "value"))
        level = heading_level or s.get("level") or (2 if raw_type in ("subtitle", "subtitulo", "subtítulo") else 1)
        try:
            level = max(1, min(6, int(level)))
        except (TypeError, ValueError):
            level = 1
        return [{"type": "heading", "text": text.strip(), "level": level}] if text.strip() else []

    if kind == "paragraph":
        text = _as_text(_first(s, "text", "content", "value", "body", "paragraph"))
        if not text.strip():
            return []
        if _looks_like_block_markdown(text):
            fixes.append("docx_paragraph_markdown_expanded")
            return parse_markdown_blocks(text)
        out = {"type": "paragraph", "text": text.strip()}
        for k in ("bold", "italic", "font_size", "color", "align"):
            if s.get(k) is not None:
                out[k] = _color(s[k]) if k == "color" else s[k]
        if isinstance(out.get("align"), str):
            out["align"] = {"centre": "center", "centrado": "center", "izquierda": "left", "derecha": "right",
                            "justificado": "justify", "justified": "justify"}.get(out["align"].lower(), out["align"].lower())
        return [out]

    if kind in ("bullets", "numbered"):
        items = _norm_items(_first(s, "items", "bullets", "points", "content", "text", "list"))
        return [{"type": kind, "items": items}] if items else []

    if kind == "table":
        headers, rows = _norm_table(_first(s, "headers", "columns", "cols", "header"), _first(s, "rows", "data", "body", "values"))
        if not headers and not rows:
            return []
        out = {"type": "table", "headers": [str(h) if not isinstance(h, str) else h for h in (headers or [])] or None, "rows": rows or []}
        for k in ("style", "caption", "column_widths"):
            if s.get(k) is not None:
                out[k] = s[k]
        if out["headers"] is None:
            del out["headers"]
        return [out]

    if kind == "quote":
        text = _as_text(_first(s, "text", "content", "quote", "value"))
        out = {"type": "quote", "text": text}
        author = _first(s, "author", "by", "source", "autor")
        if author:
            out["author"] = str(author)
        return [out] if text.strip() else []

    if kind == "code":
        text = _as_text(_first(s, "text", "code", "content"))
        out = {"type": "code", "text": text}
        lang = _first(s, "language", "lang")
        if lang:
            out["language"] = str(lang)
        return [out] if text.strip() else []

    if kind == "hyperlink":
        url = _as_text(_first(s, "url", "href", "link"))
        text = _as_text(_first(s, "text", "label", "title")) or url
        return [{"type": "hyperlink", "text": text, "url": url}] if url else []

    if kind == "callout":
        variant = CALLOUT_VARIANTS.get(str(_first(s, "variant", "style", "tone") or raw_type).lower(), "info")
        text = _as_text(_first(s, "text", "content", "body", "value"))
        out = {"type": "callout", "variant": variant, "text": text}
        title = _first(s, "title", "heading", "label")
        if title:
            out["title"] = str(title)
        return [out] if text.strip() or title else []

    if kind == "image":
        out = {"type": "image"}
        for k in ("image_base64", "image_data", "width", "height", "caption"):
            if s.get(k) is not None:
                out[k] = s[k]
        return [out]

    if kind == "toc":
        out = {"type": "toc"}
        if s.get("caption") or s.get("title"):
            out["caption"] = str(s.get("caption") or s.get("title"))
        return [out]

    return [{"type": kind}]  # divider, page_break


def _normalize_docx(payload: Any, fixes: Fixes) -> dict:
    p = _unwrap(payload, fixes, ("sections", "markdown"))
    sections = p.get("sections")
    if not isinstance(sections, list) or not sections:
        for key in ("content", "body", "blocks", "elements", "document", "secciones"):
            cand = p.get(key)
            if isinstance(cand, list) and cand:
                sections = cand
                p.pop(key, None)
                fixes.append(f"docx_sections_from_{key}")
                break
            if isinstance(cand, str) and cand.strip():
                p.setdefault("markdown", cand)
                p.pop(key, None)
                fixes.append(f"docx_markdown_from_{key}")
                break
    if isinstance(sections, str):
        p["markdown"] = (p.get("markdown") or "") + "\n\n" + sections if p.get("markdown") else sections
        sections = []
    if isinstance(sections, dict):
        sections = [sections]

    normalized: list[dict[str, Any]] = []
    for raw in sections or []:
        normalized.extend(_docx_section(raw, fixes))

    md = p.pop("markdown", None)
    if isinstance(md, str) and md.strip():
        normalized.extend(parse_markdown_blocks(md))
        fixes.append("docx_markdown_converted")
    p["sections"] = normalized

    if "theme" in p:
        p["theme"] = _normalize_theme(p["theme"], fixes, {"primary_color", "dark_color", "accent_color", "font_family"})
    if "portada" in p and "cover" not in p:
        p["cover"] = p.pop("portada")
    meta = p.get("meta") if isinstance(p.get("meta"), dict) else {}
    for key in ("author", "company", "subject"):
        if key in p and isinstance(p[key], str) and key not in meta:
            meta[key] = p.pop(key)
    if meta:
        p["meta"] = meta
    if isinstance(p.get("orientation"), str):
        page = p.get("page") if isinstance(p.get("page"), dict) else {}
        page.setdefault("orientation", p.pop("orientation").lower())
        p["page"] = page
    if isinstance(p.get("page"), dict) and isinstance(p["page"].get("orientation"), str):
        o = p["page"]["orientation"].lower()
        p["page"]["orientation"] = {"horizontal": "landscape", "vertical": "portrait", "apaisado": "landscape"}.get(o, o)
    return p


# ---- XLSX -----------------------------------------------------------------------------

_EN_THOUSANDS = re.compile(r"^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$")
_ES_THOUSANDS = re.compile(r"^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$")
_PLAIN_DOT = re.compile(r"^[-+]?\d+(\.\d+)?$")
_PLAIN_COMMA = re.compile(r"^[-+]?\d+,\d+$")
_PERCENT = re.compile(r"^([-+]?[\d.,]+)\s?%$")
_CURRENCY_PREFIX = re.compile(r"^(-)?\s*(US\$|\$|€|£|USD|EUR|ARS|MXN|COP|CLP|PEN|S/\.?)\s?([\d.,]+)$", re.I)
_CURRENCY_SUFFIX = re.compile(r"^(-)?\s*([\d.,]+)\s?(€|EUR|USD|\$)$", re.I)
_ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_ISO_DATETIME = re.compile(r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?")
_DMY_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")


def _parse_number(s: str) -> int | float | None:
    t = s.strip().replace(" ", "")
    if not t:
        return None
    digits = re.sub(r"\D", "", t)
    if len(digits) > 15:
        return None
    unsigned = t.lstrip("+-")
    if re.match(r"^0\d", unsigned):
        return None  # ceros a la izquierda: IDs, códigos, teléfonos
    has_decimals = False
    if _EN_THOUSANDS.match(t):
        has_decimals = "." in t
        t = t.replace(",", "")
    elif _ES_THOUSANDS.match(t):
        has_decimals = "," in t
        t = t.replace(".", "").replace(",", ".")
    elif _PLAIN_DOT.match(t):
        has_decimals = "." in t
    elif _PLAIN_COMMA.match(t):
        has_decimals = True
        t = t.replace(",", ".")
    else:
        return None
    value = float(t)
    if not has_decimals and value.is_integer():
        return int(value)
    return value


def _currency_format(symbol: str, decimals: bool, suffix: bool) -> str:
    sym = symbol.upper()
    body = "#,##0.00" if decimals else "#,##0"
    if sym in ("€", "EUR"):
        return f'{body} "€"' if suffix else f'"€"{body}'
    if sym == "£":
        return f'"£"{body}'
    if sym in ("$", "US$"):
        return f'"$"{body}'
    return f'"{sym} "{body}'


_TOTAL_LABEL = re.compile(r"^\s*(total(es)?( general)?|suma( total)?)\s*:?\s*$", re.IGNORECASE)


def is_total_label(value: Any) -> bool:
    """"Total", "TOTALES", "Total general"… como etiqueta de una fila de totales."""
    if isinstance(value, dict):
        value = value.get("v")
    return isinstance(value, str) and bool(_TOTAL_LABEL.match(value))


def first_filled(row: list) -> Any:
    return next((c for c in row if c not in (None, "")), None)


def coerce_cell(value: Any) -> Any:
    """Convierte texto numérico/fecha en valor real. Devuelve {"v","fmt"} si hace falta formato."""
    if not isinstance(value, str):
        return value
    s = value.strip()
    if not s:
        return value
    if s.startswith("="):
        return s
    if s.startswith("'"):
        return s[1:]

    m = _PERCENT.match(s)
    if m:
        num = _parse_number(m.group(1))
        if num is not None:
            decimals = not float(num).is_integer()
            return {"v": round(num / 100, 10), "fmt": "0.0%" if decimals else "0%"}

    m = _CURRENCY_PREFIX.match(s)
    if m:
        num = _parse_number(m.group(3))
        if num is not None:
            num = -num if m.group(1) else num
            return {"v": num, "fmt": _currency_format(m.group(2), isinstance(num, float), suffix=False)}
    m = _CURRENCY_SUFFIX.match(s)
    if m:
        num = _parse_number(m.group(2))
        if num is not None:
            num = -num if m.group(1) else num
            return {"v": num, "fmt": _currency_format(m.group(3), isinstance(num, float), suffix=True)}

    m = _ISO_DATE.match(s)
    if m:
        try:
            return {"v": dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))), "fmt": "dd/mm/yyyy"}
        except ValueError:
            return value
    m = _ISO_DATETIME.match(s)
    if m:
        try:
            return {
                "v": dt.datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), int(m.group(6) or 0)),
                "fmt": "dd/mm/yyyy hh:mm",
            }
        except ValueError:
            return value
    m = _DMY_DATE.match(s)
    if m:
        a, b, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        day, month = (a, b) if b <= 12 else (b, a)
        try:
            return {"v": dt.date(year, month, day), "fmt": "dd/mm/yyyy"}
        except ValueError:
            return value

    num = _parse_number(s)
    return num if num is not None else value


CHART_TYPE_ALIASES = {
    "bar": "bar", "bars": "bar", "column": "bar", "columns": "bar", "col": "bar", "barras": "bar",
    "columnas": "bar", "histogram": "bar", "vertical_bar": "bar",
    "barh": "barh", "horizontal_bar": "barh", "hbar": "barh", "bar_horizontal": "barh",
    "line": "line", "lines": "line", "linea": "line", "línea": "line", "lineas": "line", "líneas": "line",
    "trend": "line", "timeline": "line",
    "pie": "pie", "torta": "pie", "pastel": "pie", "circular": "pie", "tarta": "pie",
    "doughnut": "doughnut", "donut": "doughnut", "dona": "doughnut", "rosquilla": "doughnut", "ring": "doughnut",
    "area": "area", "área": "area", "areas": "area",
    "scatter": "scatter", "xy": "scatter", "dispersion": "scatter", "dispersión": "scatter", "points": "scatter",
}


def _normalize_chart(chart: Any, fixes: Fixes) -> Any:
    if not isinstance(chart, dict):
        return chart
    c = dict(chart)
    t = str(c.get("type") or c.get("kind") or "bar").strip().lower()
    mapped = CHART_TYPE_ALIASES.get(t.replace("-", "_").replace(" ", "_"))
    if mapped == "barh":
        c["type"] = "bar"
        c["horizontal"] = True
    elif mapped:
        c["type"] = mapped
    else:
        c["type"] = t  # desconocido: lo explica la validación
    c.pop("kind", None)
    if c.get("stacked") in ("true", "yes", "si", "sí"):
        c["stacked"] = True
    labels = _first(c, "labels", "categories", "x", "x_values", "etiquetas")
    if labels is not None:
        c["labels"] = [str(x) for x in labels] if isinstance(labels, list) else labels
    for k in ("categories", "x", "x_values", "etiquetas"):
        c.pop(k, None)
    series = _first(c, "series", "datasets", "data", "values")
    for k in ("datasets", "data"):
        c.pop(k, None)
    if isinstance(series, dict):
        series = [{"name": str(k), "values": v} for k, v in series.items()]
    if isinstance(series, list):
        if series and all(isinstance(v, (int, float)) or (isinstance(v, str) and _parse_number(v) is not None) for v in series):
            series = [{"name": str(c.get("title") or "Serie 1"), "values": series}]
        norm = []
        for sdef in series:
            if isinstance(sdef, str):
                norm.append({"column": sdef})
            elif isinstance(sdef, dict):
                sd = dict(sdef)
                if "label" in sd and "name" not in sd:
                    sd["name"] = sd.pop("label")
                vals = _first(sd, "values", "data", "y")
                if vals is not None:
                    sd["values"] = [coerce_cell(v) if isinstance(v, str) else v for v in vals]
                    sd["values"] = [v["v"] if isinstance(v, dict) and "v" in v else v for v in sd["values"]]
                    sd.pop("data", None)
                    sd.pop("y", None)
                if "col" in sd and "column" not in sd:
                    sd["column"] = sd.pop("col")
                norm.append(sd)
        c["series"] = norm
        c.pop("values", None)
    return c


_SHEET_INVALID = re.compile(r"[\[\]:*?/\\]")


def _sheet_name(name: Any, index: int, used: set[str]) -> str:
    base = _SHEET_INVALID.sub(" ", str(name or f"Hoja {index + 1}"))
    base = re.sub(r"\s+", " ", base).strip().strip("'") or f"Hoja {index + 1}"
    base = base[:31]
    candidate = base
    n = 2
    while candidate.lower() in used:
        suffix = f" ({n})"
        candidate = base[: 31 - len(suffix)] + suffix
        n += 1
    used.add(candidate.lower())
    return candidate


def _normalize_sheet(raw: Any, index: int, used: set[str], fixes: Fixes) -> dict[str, Any] | None:
    if isinstance(raw, list):
        raw = {"rows": raw}
    if not isinstance(raw, dict):
        return None
    s = dict(raw)
    s["name"] = _sheet_name(_first(s, "name", "sheet", "sheet_name", "nombre"), index, used)
    for k in ("sheet", "sheet_name", "nombre"):
        s.pop(k, None)

    headers = _first(s, "headers", "columns", "cols", "header", "encabezados")
    rows = _first(s, "rows", "data", "values", "body", "filas")
    for k in ("columns", "cols", "header", "encabezados", "data", "values", "body", "filas"):
        s.pop(k, None)

    widths: list[float] = []
    formats: dict[str, str] = {}
    if isinstance(headers, list) and headers and all(isinstance(h, dict) for h in headers):
        names = []
        for h in headers:
            names.append(str(_first(h, "name", "header", "title", "label", "key") or ""))
            if isinstance(h.get("width"), (int, float)):
                widths.append(float(h["width"]))
            fmt = _first(h, "format", "number_format")
            if isinstance(fmt, str):
                formats[names[-1]] = fmt
        headers = names
    headers, rows = _norm_table(headers, rows)
    if headers:
        s["headers"] = [str(h) if h is not None else "" for h in headers]
    if rows is not None:
        s["rows"] = [[coerce_cell(v) for v in row] for row in rows]
    if widths and not s.get("column_widths"):
        s["column_widths"] = widths
    if formats:
        s["number_formats"] = {**formats, **(s.get("number_formats") or {})}

    chart = _first(s, "chart", "graph", "grafico", "gráfico")
    for k in ("graph", "grafico", "gráfico"):
        s.pop(k, None)
    if chart is not None:
        s["chart"] = _normalize_chart(chart, fixes)
    if isinstance(s.get("charts"), list):
        s["charts"] = [_normalize_chart(c, fixes) for c in s["charts"]]

    summary = _first(s, "summary_row", "total_row", "totals", "totales")
    for k in ("total_row", "totals", "totales"):
        s.pop(k, None)
    if summary is True or summary == "true":
        s["summary_row"] = {"label": "Total"}
    elif isinstance(summary, str):
        s["summary_row"] = {"label": "Total", "formula": summary.upper()} if summary.upper() in ("SUM", "AVERAGE", "MAX", "MIN", "COUNT") else {"label": summary}
    elif isinstance(summary, dict):
        s["summary_row"] = summary
    elif "summary_row" in s:
        s.pop("summary_row")
    # Con summary_row el builder calcula el total; una fila "Total" del modelo lo duplicaría.
    rows_now = s.get("rows")
    if s.get("summary_row") and isinstance(rows_now, list) and rows_now and isinstance(rows_now[-1], list):
        if is_total_label(first_filled(rows_now[-1])):
            rows_now.pop()
            fixes.append("xlsx_duplicate_total_row_removed")

    freeze = s.get("freeze", s.pop("freeze_header", None))
    if freeze is True:
        s["freeze"] = {"rows": 1, "cols": 0}
    elif freeze is False:
        s["freeze"] = {"rows": 0, "cols": 0}
    elif isinstance(freeze, str) and re.fullmatch(r"[A-Za-z]{1,3}\d+", freeze.strip()):
        s["freeze"] = {"top_left_cell": freeze.strip().upper()}
    if "tab_color" in s:
        s["tab_color"] = _color(s["tab_color"])
    if isinstance(s.get("styling"), (dict, str)):
        s["styling"] = _normalize_theme(s["styling"], fixes, {"primary_color", "accent_color", "header_fill", "header_font_color", "alt_row_fill", "font_family"})
    return s


def _normalize_xlsx(payload: Any, fixes: Fixes) -> dict:
    p = _unwrap(payload, fixes, ("sheets",))
    sheets = p.get("sheets")
    if not isinstance(sheets, (list, dict)) or not sheets:
        for key in ("worksheets", "tabs", "hojas", "pages"):
            if isinstance(p.get(key), (list, dict)) and p[key]:
                sheets = p.pop(key)
                fixes.append(f"xlsx_sheets_from_{key}")
                break
    if (not sheets) and any(k in p for k in ("headers", "rows", "columns", "data")):
        single = {k: p.pop(k) for k in ("headers", "rows", "columns", "data", "chart", "summary_row", "freeze") if k in p}
        single["name"] = p.get("sheet_name") or p.get("title") or "Hoja 1"
        if p.get("title"):
            single["title"] = p["title"]
        sheets = [single]
        fixes.append("xlsx_single_sheet_wrapped")
    if isinstance(sheets, dict):
        sheets = [({"name": k, **v} if isinstance(v, dict) else {"name": k, "rows": v}) for k, v in sheets.items()]
    used: set[str] = set()
    out = []
    for i, raw in enumerate(sheets or []):
        sheet = _normalize_sheet(raw, i, used, fixes)
        if sheet is not None:
            out.append(sheet)
    p["sheets"] = out
    if "theme" in p:
        p["theme"] = _normalize_theme(p["theme"], fixes, {"primary_color", "accent_color", "header_fill", "header_font_color", "alt_row_fill", "font_family"})
    return p


# ---- PPTX -----------------------------------------------------------------------------

PPTX_LAYOUT_ALIASES = {
    "title": "title", "cover": "title", "portada": "title", "title_slide": "title", "intro": "title",
    "content": "content", "bullets": "content", "bullet": "content", "list": "content", "text": "content",
    "body": "content", "standard": "content", "default": "content", "contenido": "content", "bullet_points": "content",
    "two_columns": "two_columns", "two_column": "two_columns", "columns": "two_columns", "comparison": "two_columns",
    "compare": "two_columns", "dos_columnas": "two_columns", "2col": "two_columns", "split": "two_columns",
    "comparacion": "two_columns", "comparación": "two_columns",
    "image_left": "image_left", "image_right": "image_right", "image": "image_right", "picture": "image_right",
    "imagen": "image_right",
    "table": "table", "tabla": "table",
    "chart": "chart", "graph": "chart", "grafico": "chart", "gráfico": "chart",
    "quote": "quote", "cita": "quote",
    "section_header": "section_header", "section": "section_header", "divider": "section_header",
    "separator": "section_header", "seccion": "section_header", "sección": "section_header",
    "closing": "closing", "end": "closing", "thanks": "closing", "thank_you": "closing", "cierre": "closing",
    "gracias": "closing", "final": "closing",
    "stats": "stats", "kpi": "stats", "kpis": "stats", "metrics": "stats", "numbers": "stats",
    "metricas": "stats", "métricas": "stats", "indicadores": "stats",
    "agenda": "agenda", "toc": "agenda", "index": "agenda", "indice": "agenda", "índice": "agenda", "outline": "agenda",
    "custom": "custom",
}


def _flatten_bullets(items: list[Any], level: int = 0) -> list[Any]:
    out: list[Any] = []
    for it in items:
        if isinstance(it, dict):
            text = it.get("text", "")
            lvl = it.get("level")
            if isinstance(lvl, int) and "children" not in it:
                out.append({"text": text, "level": max(0, min(4, lvl))} if lvl else text)
                continue
            out.append(text if level == 0 else {"text": text, "level": level})
            out.extend(_flatten_bullets(it.get("children", []), level + 1))
        else:
            out.append(it if level == 0 else {"text": it, "level": level})
    return out


def _pptx_bullets(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        prepared = []
        for v in value:
            if isinstance(v, dict) and isinstance(v.get("level"), (int, str)) and "children" not in v:
                try:
                    lvl = int(v["level"])
                except ValueError:
                    lvl = 0
                text = _as_text(_first(v, "text", "content", "title"))
                prepared.append({"text": text, "level": lvl} if lvl else text)
            else:
                prepared.extend(_flatten_bullets(_norm_items([v])))
        return [p for p in prepared if (p.get("text") if isinstance(p, dict) else p)]
    return _flatten_bullets(_norm_items(value))


def _normalize_slide(raw: Any, index: int, total: int, fixes: Fixes) -> dict[str, Any] | None:
    if isinstance(raw, str):
        lines = [ln for ln in raw.strip().split("\n") if ln.strip()]
        if not lines:
            return None
        raw = {"title": lines[0].lstrip("# ").strip(), "bullets": "\n".join(lines[1:])} if len(lines) > 1 else {"title": lines[0]}
    if not isinstance(raw, dict):
        return None
    s = dict(raw)
    raw_layout = str(_first(s, "layout", "type", "kind", "template") or "").strip().lower().replace("-", "_").replace(" ", "_")
    for k in ("type", "kind", "template"):
        s.pop(k, None)
    layout = PPTX_LAYOUT_ALIASES.get(raw_layout, "")

    if not layout:
        if raw_layout:
            layout = raw_layout  # desconocido: lo explica la validación
        elif _first(s, "stats", "kpis", "metrics"):
            layout = "stats"
        elif _first(s, "chart") or (_first(s, "series") and _first(s, "labels")):
            layout = "chart"
        elif _first(s, "headers", "rows"):
            layout = "table"
        elif _first(s, "left_column", "right_column", "columns", "left", "right"):
            layout = "two_columns"
        elif _first(s, "quote") or (_first(s, "text") and _first(s, "author")):
            layout = "quote"
        elif _first(s, "objects"):
            layout = "custom"
        elif _first(s, "bullets", "points", "items", "content", "body", "paragraph", "text"):
            layout = "content"
        elif _first(s, "title"):
            layout = "title" if index == 0 else ("closing" if index == total - 1 and _first(s, "subtitle") else "section_header")
        else:
            return None
    s["layout"] = layout

    notes = _first(s, "notes", "speaker_notes", "notas")
    for k in ("speaker_notes", "notas"):
        s.pop(k, None)
    if notes is not None:
        s["notes"] = _as_text(notes)
    if s.get("title") is not None and not isinstance(s["title"], str):
        s["title"] = _as_text(s["title"])

    if layout == "content":
        body = _first(s, "bullets", "points", "items", "content", "body")
        for k in ("points", "items", "content", "body"):
            s.pop(k, None)
        if isinstance(body, str) and "\n" not in body.strip() and not _LIST_MARKER_RE.match(body) and not s.get("paragraph"):
            s["paragraph"] = body.strip()
            s.pop("bullets", None)
        elif body is not None:
            s["bullets"] = _pptx_bullets(body)
        if isinstance(s.get("text"), str) and not s.get("bullets") and not s.get("paragraph"):
            s["paragraph"] = s.pop("text")
    elif layout == "two_columns":
        cols = s.pop("columns", None)
        if isinstance(cols, list) and len(cols) >= 2:
            for side, col in zip(("left", "right"), cols[:2]):
                if isinstance(col, dict):
                    if _first(col, "title", "heading"):
                        s[f"{side}_title"] = _as_text(_first(col, "title", "heading"))
                    s[f"{side}_column"] = _pptx_bullets(_first(col, "bullets", "items", "points", "content", "text"))
                else:
                    s[f"{side}_column"] = _pptx_bullets(col)
        for side in ("left", "right"):
            if f"{side}_column" not in s and side in s:
                s[f"{side}_column"] = _pptx_bullets(s.pop(side))
            elif f"{side}_column" in s:
                s[f"{side}_column"] = _pptx_bullets(s[f"{side}_column"])
    elif layout in ("image_left", "image_right"):
        if s.get("bullets") is not None:
            s["bullets"] = _pptx_bullets(s["bullets"])
    elif layout == "table":
        headers, rows = _norm_table(_first(s, "headers", "columns", "cols"), _first(s, "rows", "data", "values"))
        for k in ("columns", "cols", "data", "values"):
            s.pop(k, None)
        if headers:
            s["headers"] = [str(h) for h in headers]
        s["rows"] = [["" if v is None else v for v in r] for r in (rows or [])]
    elif layout == "chart":
        chart = s.get("chart")
        if not isinstance(chart, dict):
            chart = {k: s.pop(k) for k in ("labels", "series", "categories", "values") if k in s}
            if isinstance(s.get("chart"), str):
                chart["type"] = s["chart"]
        s["chart"] = _normalize_chart(chart, fixes)
    elif layout == "stats":
        stats = _first(s, "stats", "kpis", "metrics", "numbers", "items")
        for k in ("kpis", "metrics", "numbers", "items"):
            s.pop(k, None)
        out = []
        for st in stats if isinstance(stats, list) else []:
            if isinstance(st, dict):
                value = _first(st, "value", "number", "valor", "metric", "kpi")
                label = _first(st, "label", "name", "title", "description", "etiqueta")
                item = {"value": "" if value is None else str(value), "label": "" if label is None else str(label)}
                detail = _first(st, "detail", "delta", "change", "subtitle", "note")
                if detail is not None:
                    item["detail"] = str(detail)
                out.append(item)
            elif st is not None:
                out.append({"value": str(st), "label": ""})
        s["stats"] = out
    elif layout == "agenda":
        items = _first(s, "items", "points", "bullets", "sections", "content")
        for k in ("points", "bullets", "sections", "content"):
            s.pop(k, None)
        s["items"] = [it if isinstance(it, str) else it.get("text", "") for it in _flatten_bullets(_norm_items(items))]
        s.setdefault("title", "Agenda")
    elif layout == "quote":
        if "quote" in s and "text" not in s:
            s["text"] = _as_text(s.pop("quote"))
    if s.get("background_color"):
        s["background_color"] = _color(s["background_color"])
    return s


def _normalize_pptx(payload: Any, fixes: Fixes) -> dict:
    p = _unwrap(payload, fixes, ("slides",))
    slides = p.get("slides")
    if not isinstance(slides, list) or not slides:
        for key in ("pages", "diapositivas", "content", "presentation"):
            if isinstance(p.get(key), list) and p[key]:
                slides = p.pop(key)
                fixes.append(f"pptx_slides_from_{key}")
                break
    out = []
    total = len(slides or [])
    for i, raw in enumerate(slides or []):
        s = _normalize_slide(raw, i, total, fixes)
        if s is not None:
            out.append(s)
    p["slides"] = out
    if "theme" in p:
        p["theme"] = _normalize_theme(p["theme"], fixes, {
            "primary_color", "secondary_color", "accent_color", "background_color", "dark_color", "light_color", "font_family",
        })
    return p


# ---- Entrada pública ------------------------------------------------------------------


def normalize_payload(fmt: str, payload: Any) -> tuple[dict, Fixes]:
    fixes: Fixes = []
    if fmt == "docx":
        return _normalize_docx(payload, fixes), fixes
    if fmt == "xlsx":
        return _normalize_xlsx(payload, fixes), fixes
    if fmt == "pptx":
        return _normalize_pptx(payload, fixes), fixes
    return (payload if isinstance(payload, dict) else {}), fixes


def format_validation_error(err: Exception, limit: int = 6, max_len: int = 600) -> str:
    """Resumen corto de un ValidationError de pydantic: `ruta: mensaje; ...`."""
    errors_fn = getattr(err, "errors", None)
    if not callable(errors_fn):
        return str(err)[:max_len]
    try:
        errors = errors_fn(include_url=False)
    except TypeError:
        errors = errors_fn()
    parts = []
    for e in errors[:limit]:
        loc = ".".join(str(x) for x in e.get("loc", ()))
        msg = str(e.get("msg", "")).replace("\n", " ")
        if len(msg) > 180:
            msg = msg[:177] + "..."
        parts.append(f"{loc}: {msg}" if loc else msg)
    extra = len(errors) - limit
    summary = "; ".join(parts) + (f"; (+{extra} errores más)" if extra > 0 else "")
    return summary[:max_len]
