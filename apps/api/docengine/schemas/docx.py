"""DOCX schema — sections discriminated by `type` field."""

from __future__ import annotations

from typing import Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


class DocxTheme(BaseModel):
    model_config = ConfigDict(extra="allow")
    primary_color: str | None = None
    dark_color: str | None = None
    font_family: str | None = None


class PageSetup(BaseModel):
    model_config = ConfigDict(extra="allow")
    orientation: Literal["portrait", "landscape"] = "portrait"
    margins: dict[str, float] | None = None


class DocxMeta(BaseModel):
    model_config = ConfigDict(extra="allow")
    author: str | None = None
    company: str | None = None
    title: str | None = None
    subject: str | None = None


class _BaseSection(BaseModel):
    model_config = ConfigDict(extra="allow")


class HeadingSection(_BaseSection):
    type: Literal["heading"] = "heading"
    text: str = ""
    level: int = 1


class ParagraphSection(_BaseSection):
    type: Literal["paragraph"] = "paragraph"
    text: str = ""
    bold: bool | None = None
    italic: bool | None = None
    font_size: int | None = None
    color: str | None = None
    align: Literal["left", "center", "right", "justify"] | None = None


class BulletsSection(_BaseSection):
    type: Literal["bullets"] = "bullets"
    items: list[str] = Field(default_factory=list)


class NumberedSection(_BaseSection):
    type: Literal["numbered"] = "numbered"
    items: list[str] = Field(default_factory=list)


class TableSection(_BaseSection):
    type: Literal["table"] = "table"
    headers: list[str] | None = None
    rows: list[list[Any]] | None = None
    style: str | None = None


class QuoteSection(_BaseSection):
    type: Literal["quote"] = "quote"
    text: str = ""
    author: str | None = None


class CodeSection(_BaseSection):
    type: Literal["code"] = "code"
    text: str = ""


class ImageSection(_BaseSection):
    type: Literal["image"] = "image"
    image_base64: str | None = None
    image_data: str | None = None
    width: int | None = None
    height: int | None = None
    caption: str | None = None


class HyperlinkSection(_BaseSection):
    type: Literal["hyperlink"] = "hyperlink"
    text: str = ""
    url: str = ""


class TocSection(_BaseSection):
    type: Literal["toc"] = "toc"
    caption: str | None = None


class DividerSection(_BaseSection):
    type: Literal["divider"] = "divider"


class PageBreakSection(_BaseSection):
    type: Literal["page_break"] = "page_break"


Section = Union[
    HeadingSection,
    ParagraphSection,
    BulletsSection,
    NumberedSection,
    TableSection,
    QuoteSection,
    CodeSection,
    ImageSection,
    HyperlinkSection,
    TocSection,
    DividerSection,
    PageBreakSection,
]


class DocxPayload(BaseModel):
    model_config = ConfigDict(extra="allow")
    filename: str | None = None
    theme: DocxTheme = Field(default_factory=DocxTheme)
    title: str | None = None
    subtitle: str | None = None
    meta: DocxMeta = Field(default_factory=DocxMeta)
    page: PageSetup = Field(default_factory=PageSetup)
    sections: list[Section] = Field(default_factory=list)
