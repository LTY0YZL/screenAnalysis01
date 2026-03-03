from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field


def _default_data_dir() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA", Path.home()))
        return root / "ScreenAnalysis"
    return Path.home() / ".screenanalysis"


class Settings(BaseModel):
    app_name: str = "ScreenAnalysis Engine"
    app_version: str = "0.1.0"
    host: str = Field(default_factory=lambda: os.environ.get("SCREENANALYSIS_HOST", "127.0.0.1"))
    port: int = Field(default_factory=lambda: int(os.environ.get("SCREENANALYSIS_PORT", "41234")))
    launch_token: str = Field(default_factory=lambda: os.environ.get("SCREENANALYSIS_LAUNCH_TOKEN", "dev-token"))
    default_analysis_mode: str = Field(default_factory=lambda: os.environ.get("SCREENANALYSIS_DEFAULT_MODE", "mock"))
    gemini_api_key: str | None = Field(default_factory=lambda: os.environ.get("GEMINI_API_KEY"))
    gemini_model: str = Field(default_factory=lambda: os.environ.get("GEMINI_MODEL", "gemini-1.5-flash"))
    openai_api_key: str | None = Field(default_factory=lambda: os.environ.get("OPENAI_API_KEY"))
    openai_model: str = Field(default_factory=lambda: os.environ.get("OPENAI_MODEL", "gpt-4.1-mini"))
    anthropic_api_key: str | None = Field(default_factory=lambda: os.environ.get("ANTHROPIC_API_KEY"))
    anthropic_model: str = Field(default_factory=lambda: os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022"))
    embedding_model: str = Field(
        default_factory=lambda: os.environ.get("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
    )
    data_dir: Path = Field(default_factory=lambda: Path(os.environ.get("SCREENANALYSIS_DATA_DIR", _default_data_dir())))
    chroma_collection: str = "screenanalysis_records"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def sqlite_dir(self) -> Path:
        return self.data_dir / "sqlite"

    @property
    def sqlite_file(self) -> Path:
        return self.sqlite_dir / "screenanalysis.db"

    @property
    def chroma_dir(self) -> Path:
        return self.data_dir / "chroma"

    @property
    def logs_dir(self) -> Path:
        return self.data_dir / "logs"


settings = Settings()


def ensure_storage_dirs() -> None:
    for folder in [settings.data_dir, settings.images_dir, settings.sqlite_dir, settings.chroma_dir, settings.logs_dir]:
        folder.mkdir(parents=True, exist_ok=True)
