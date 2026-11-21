"""Shared theme + visual helpers for all builders."""

from __future__ import annotations


# ---- Default palettes ----------------------------------------------------------

DEFAULT_PPTX_THEME = {
    "primary_color": "#0D95A1",
    "secondary_color": "#067A85",
    "accent_color": "#F59E0B",
    "background_color": "#FFFFFF",
    "dark_color": "#0F172A",
    "light_color": "#F8FBFC",
    "font_family": "Calibri",
}

DEFAULT_XLSX_THEME = {
    "primary_color": "#1E293B",
    "accent_color": "#2563EB",
    "header_fill": "#1E293B",
    "header_font_color": "#FFFFFF",
    "alt_row_fill": "#F1F5F9",
    "font_family": "Calibri",
}

DEFAULT_DOCX_THEME = {
    "primary_color": "#0D95A1",
    "dark_color": "#0F172A",
    "font_family": "Calibri",
}


# ---- Color helpers -------------------------------------------------------------

def hex_to_rgb(color: str) -> tuple[int, int, int]:
    """Convert '#RRGGBB' (or 'RRGGBB') to (r, g, b) tuple."""
    if not color:
        return (13, 149, 161)
    c = color.lstrip("#").upper()
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6:
        return (13, 149, 161)
    try:
        return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
    except ValueError:
        return (13, 149, 161)


def resolve_theme(theme: dict | None, defaults: dict) -> dict:
    """Merge user theme on top of defaults. Missing keys fall back to defaults."""
    return {**defaults, **(theme or {})}


def strip_hash(color: str | None, default: str = "0D95A1") -> str:
    """Return RRGGBB (no #). Used for OOXML color attributes."""
    if not color:
        return default
    c = color.lstrip("#").upper()
    return c if len(c) == 6 else default


# ---- Layout helpers ------------------------------------------------------------

EMU_PER_INCH = 914400


def inches(value: float) -> int:
    return int(round(value * EMU_PER_INCH))


def cm(value: float) -> int:
    return int(round(value * EMU_PER_INCH / 2.54))
