from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.prompt_template import PromptTemplate

DEFAULT_TEMPLATES = {
    "explain_code": (
        "You are an expert programmer. Explain the screenshot content concisely. "
        "Include likely complexity, possible bugs, and suggested fixes.\n\n"
        "Context variables: {variables}"
    ),
    "translate": "Translate the screenshot content to {target_language}. Keep formatting and code blocks unchanged.",
    "debug_error": "Explain likely cause and first troubleshooting steps for the error in this screenshot.",
}


class PromptService:
    @staticmethod
    def ensure_seed_templates(db: Session) -> None:
        for name, template in DEFAULT_TEMPLATES.items():
            existing = db.execute(select(PromptTemplate).where(PromptTemplate.name == name)).scalar_one_or_none()
            if not existing:
                db.add(PromptTemplate(name=name, template=template))
        db.commit()

    @staticmethod
    def get_template_text(db: Session, template_key: str | None) -> tuple[int | None, str | None, str]:
        if not template_key:
            return None, "default", "Describe the key information in this screenshot."
        lookup = db.execute(
            select(PromptTemplate).where((PromptTemplate.name == template_key) | (PromptTemplate.id == _int_or_minus(template_key)))
        ).scalar_one_or_none()
        if lookup:
            return lookup.id, lookup.name, lookup.template
        return None, template_key, "Describe the key information in this screenshot."

    @staticmethod
    def render(template_text: str, overrides: dict[str, Any], fallback_content: str = "") -> str:
        result = template_text
        for key, value in overrides.items():
            result = result.replace(f"{{{{{key}}}}}", str(value))
            result = result.replace(f"{{{key}}}", str(value))
        if "{{content}}" in result or "{content}" in result:
            result = result.replace("{{content}}", fallback_content).replace("{content}", fallback_content)
        if "{{variables}}" in result or "{variables}" in result:
            result = result.replace("{{variables}}", str(overrides)).replace("{variables}", str(overrides))
        result = re.sub(r"\{\{[^}]+\}\}", "", result)
        return result.strip()


def _int_or_minus(value: str | None) -> int:
    try:
        return int(value or "-1")
    except ValueError:
        return -1
