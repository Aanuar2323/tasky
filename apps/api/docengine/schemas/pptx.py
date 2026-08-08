"""PPTX schema — slide layouts discriminated by `layout` field."""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


# ---- Theme --------------------------------------------------------------------

class PptxTheme(BaseModel):
    model_config = ConfigDict(extra="forbid")
    primary_color: str | None = None
    secondary_color: str | None = None
    accent_color: str | None = None
    background_color: str | None = None
    dark_color: str | None = None
    light_color: str | None = None
    font_family: str | None = None


# ---- Chart --------------------------------------------------------------------

class ChartSeries(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    values: list[float | int | str] = Field(default_factory=list)


class SlideChart(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["bar", "line", "pie", "scatter"] = "bar"
    title: str | None = None
    labels: list[str] | None = None
    series: list[ChartSeries] | None = None
    show_legend: bool = True


# ---- Custom objects -----------------------------------------------------------

class CustomObject(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: Literal["text", "shape", "image", "chart", "table"]
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    content: str | None = None
    bullets: list[str] | None = None
    table: dict[str, Any] | None = None
    image_base64: str | None = None
    image_data: str | None = None
    chart: SlideChart | None = None
    shape: str | None = None
    color: str | None = None
    fill: str | None = None
    font_size: int | None = None
    bold: bool | None = None


# ---- Slide layouts -------------------------------------------------------------

class _BaseSlide(BaseModel):
    model_config = ConfigDict(extra="allow")
    background_color: str | None = None
    notes: str | None = None
    slide_number: bool | None = None


class TitleSlide(_BaseSlide):
    layout: Literal["title"] = "title"
    title: str = ""
    subtitle: str | None = None


class ContentSlide(_BaseSlide):
    layout: Literal["content"] = "content"
    title: str = ""
    bullets: list[str] | None = None
    paragraph: str | None = None


class TwoColumnsSlide(_BaseSlide):
    layout: Literal["two_columns"] = "two_columns"
    title: str = ""
    left_column: list[str] | None = None
    right_column: list[str] | None = None


class ImageLeftSlide(_BaseSlide):
    layout: Literal["image_left"] = "image_left"
    title: str = ""
    image_base64: str | None = None
    image_data: str | None = None
    bullets: list[str] | None = None


class ImageRightSlide(_BaseSlide):
    layout: Literal["image_right"] = "image_right"
    title: str = ""
    image_base64: str | None = None
    image_data: str | None = None
    bullets: list[str] | None = None


class TableSlide(_BaseSlide):
    layout: Literal["table"] = "table"
    title: str = ""
    headers: list[str] | None = None
    rows: list[list[Any]] | None = None


class ChartSlide(_BaseSlide):
    layout: Literal["chart"] = "chart"
    title: str = ""
    chart: SlideChart = Field(default_factory=lambda: SlideChart())


class QuoteSlide(_BaseSlide):
    layout: Literal["quote"] = "quote"
    text: str = ""
    author: str | None = None


class SectionHeaderSlide(_BaseSlide):
    layout: Literal["section_header"] = "section_header"
    title: str = ""


class ClosingSlide(_BaseSlide):
    layout: Literal["closing"] = "closing"
    title: str = ""
    subtitle: str | None = None


class CustomSlide(_BaseSlide):
    layout: Literal["custom"] = "custom"
    objects: list[CustomObject] = Field(default_factory=list)


Slide = Union[
    TitleSlide,
    ContentSlide,
    TwoColumnsSlide,
    ImageLeftSlide,
    ImageRightSlide,
    TableSlide,
    ChartSlide,
    QuoteSlide,
    SectionHeaderSlide,
    ClosingSlide,
    CustomSlide,
]


# ---- Top-level payload --------------------------------------------------------

class PptxPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    filename: str | None = None
    theme: PptxTheme = Field(default_factory=PptxTheme)
    title: str | None = None
    author: str | None = None
    company: str | None = None
    subject: str | None = None
    slides: list[Slide] = Field(default_factory=list)
