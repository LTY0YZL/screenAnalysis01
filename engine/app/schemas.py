from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ApiError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class ApiSuccess(BaseModel):
    ok: bool = True
    data: dict[str, Any]


class ApiFailure(BaseModel):
    ok: bool = False
    error: ApiError


class AnalyzeRequest(BaseModel):
    image_base64: str
    prompt_template_id: str | None = None
    prompt_overrides: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    analysis_mode: str | None = None
    model_override: str | None = None


class EmbedRequest(BaseModel):
    text: str
    record_id: int | None = None


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5


class ChatRequest(BaseModel):
    message_id: str | None = None
    question: str
    analysis_mode: str | None = None
    extra_context: str | None = None
    model_override: str | None = None


class PromptTemplateCreate(BaseModel):
    name: str
    template: str


class PromptTemplateOut(BaseModel):
    id: int
    name: str
    template: str


class RecordOut(BaseModel):
    id: int
    created_at: datetime
    image_path: str
    image_base64: str | None = None
    ocr_text: str | None = None
    model_text: str | None = None
    prompt_template_id: int | None = None
    prompt_template_name: str | None = None
    prompt_text: str
    metadata: dict[str, Any]
    embedding_id: str | None = None


class SearchResultOut(BaseModel):
    record_id: int
    score: float
    snippet: str
