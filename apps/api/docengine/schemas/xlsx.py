"""XLSX schema — hojas con encabezados, filas, gráficos, tablas de Excel, etc."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class XlsxTheme(BaseModel):
    model_config = ConfigDict(extra="allow")
    primary_color: str | None = None
    accent_color: str | None = None
    header_fill: str | None = None
    header_font_color: str | None = None
    alt_row_fill: str | None = None
    font_family: str | None = None


class XlsxChart(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["bar", "line", "pie", "scatter", "doughnut", "area"] = "bar"
    title: str | None = None
    labels: list[str] | None = None
    labels_column: str | None = None
    series: list[dict[str, Any]] | None = None
    horizontal: bool = False
    stacked: bool = False
    data_labels: bool = False
    x_title: str | None = None
    y_title: str | None = None
    anchor_cell: str | None = None
    width: float = 16
    height: float = 8.5
    show_legend: bool = True


class FreezePane(BaseModel):
    model_config = ConfigDict(extra="allow")
    rows: int = 0
    cols: int = 0
    top_left_cell: str | None = None


class ConditionalFormatRule(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: str = "cell_is"
    operator: str | None = None
    formula: list[str] | None = None
    fill_color: str | None = None
    font_color: str | None = None
    range: str | None = None


class DataValidation(BaseModel):
    model_config = ConfigDict(extra="allow")
    cells: str
    type: str = "whole"
    operator: str | None = None
    formula1: str | None = None
    formula2: str | None = None
    allow_blank: bool = True


class SummaryRow(BaseModel):
    model_config = ConfigDict(extra="allow")
    label: str = "Total"
    formula: str = "SUM"
    fill_color: str | None = None


class Sheet(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str = "Hoja 1"
    title: str | None = None
    headers: list[str] | None = None
    rows: list[list[Any]] | None = None
    column_widths: list[float] | None = None
    number_formats: dict[str, str] | None = None
    merge_cells: list[str] | None = None
    freeze: FreezePane | None = None
    chart: XlsxChart | None = None
    charts: list[XlsxChart] | None = None
    styling: XlsxTheme | None = None
    summary_row: SummaryRow | None = None
    conditional_formatting: list[ConditionalFormatRule] | None = None
    data_validations: list[DataValidation] | None = None
    tab_color: str | None = None
    auto_filter: bool = True
    as_table: bool = True
    table_style: str | None = None
    wrap_text: bool = False


class XlsxPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    filename: str | None = None
    theme: XlsxTheme = Field(default_factory=XlsxTheme)
    creator: str | None = None
    company: str | None = None
    sheets: list[Sheet] = Field(default_factory=list)
