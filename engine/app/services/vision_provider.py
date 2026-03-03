from __future__ import annotations

import time
from base64 import b64encode
from dataclasses import dataclass
from typing import Generator

import requests

from app.core.config import settings


@dataclass
class VisionResult:
    text: str
    confidence: float
    raw: dict
    provider: str
    model_name: str


class VisionProvider:
    def analyze(self, image_bytes: bytes, prompt: str) -> VisionResult:  # pragma: no cover - interface only
        raise NotImplementedError

    def stream(self, image_bytes: bytes, prompt: str) -> Generator[str, None, VisionResult]:  # pragma: no cover
        raise NotImplementedError

    def chat(self, prompt: str) -> VisionResult:  # pragma: no cover - interface only
        raise NotImplementedError


class MockVisionProvider(VisionProvider):
    def analyze(self, image_bytes: bytes, prompt: str) -> VisionResult:
        size_kb = round(len(image_bytes) / 1024.0, 2)
        text = (
            "Mock analysis complete. "
            f"Image size: {size_kb} KB. "
            f"Prompt summary: {prompt[:300]}"
        )
        return VisionResult(
            text=text,
            confidence=0.88,
            raw={"mode": "mock", "byte_size": len(image_bytes), "prompt": prompt},
            provider="mock",
            model_name="mock-vision-v1",
        )

    def stream(self, image_bytes: bytes, prompt: str) -> Generator[str, None, VisionResult]:
        result = self.analyze(image_bytes, prompt)
        words = result.text.split(" ")
        built = []
        for word in words:
            built.append(word)
            time.sleep(0.02)
            yield f"{word} "
        return VisionResult(
            text=" ".join(built).strip(),
            confidence=result.confidence,
            raw=result.raw,
            provider=result.provider,
            model_name=result.model_name,
        )

    def chat(self, prompt: str) -> VisionResult:
        text = f"Mock chat response based on your context:\n{prompt[:800]}"
        return VisionResult(
            text=text,
            confidence=0.85,
            raw={"mode": "mock_chat"},
            provider="mock",
            model_name="mock-vision-v1",
        )


class GeminiVisionProvider(VisionProvider):
    def __init__(self, model_override: str | None = None) -> None:
        if not settings.gemini_api_key:
            raise RuntimeError("Missing GEMINI_API_KEY")
        self._api_base = "https://generativelanguage.googleapis.com/v1beta"
        self._requested_model = (model_override or settings.gemini_model).strip()

    def analyze(self, image_bytes: bytes, prompt: str) -> VisionResult:
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": prompt},
                        {
                            "inline_data": {
                                "mime_type": "image/png",
                                "data": b64encode(image_bytes).decode("utf-8"),
                            }
                        },
                    ],
                }
            ]
        }
        raw, resolved_model = self._generate_with_fallback(payload)
        text = _extract_gemini_text(raw)
        return VisionResult(
            text=text.strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="gemini",
            model_name=resolved_model,
        )

    def stream(self, image_bytes: bytes, prompt: str) -> Generator[str, None, VisionResult]:
        result = self.analyze(image_bytes, prompt)
        full_text = result.text
        for token in full_text.split(" "):
            yield f"{token} "
        return VisionResult(
            text=full_text,
            confidence=0.9 if full_text else 0.2,
            raw={"streamed": True, "provider": "gemini_http"},
            provider="gemini",
            model_name=settings.gemini_model,
        )

    def chat(self, prompt: str) -> VisionResult:
        payload = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": prompt}],
                }
            ]
        }
        raw, resolved_model = self._generate_with_fallback(payload)
        text = _extract_gemini_text(raw)
        return VisionResult(
            text=text.strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="gemini",
            model_name=resolved_model,
        )

    def _generate_with_fallback(self, payload: dict) -> tuple[dict, str]:
        candidates = self._candidate_models(self._requested_model)
        last_err = None
        for model in candidates:
            endpoint = f"{self._api_base}/models/{model}:generateContent"
            response = requests.post(
                endpoint,
                params={"key": settings.gemini_api_key},
                headers={"Content-Type": "application/json"},
                json=payload,
                timeout=60,
            )
            if response.status_code == 404:
                last_err = RuntimeError(f"Gemini model '{model}' not found.")
                continue
            response.raise_for_status()
            return response.json(), model
        if last_err:
            raise RuntimeError(
                f"Gemini model '{self._requested_model}' is unavailable. "
                "Set GEMINI_MODEL to a valid model for your key (for example: gemini-2.0-flash or gemini-1.5-flash-latest)."
            ) from last_err
        raise RuntimeError("Gemini request failed with unknown error.")

    @staticmethod
    def _candidate_models(requested: str) -> list[str]:
        base = requested.strip()
        candidates = [base]
        if not base.endswith("-latest"):
            candidates.append(f"{base}-latest")
        if not base.endswith("-001"):
            candidates.append(f"{base}-001")
        if not base.endswith("-002"):
            candidates.append(f"{base}-002")
        candidates.extend(
            [
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite",
                "gemini-1.5-flash-latest",
                "gemini-1.5-pro-latest",
            ]
        )
        deduped = []
        seen = set()
        for item in candidates:
            if item and item not in seen:
                seen.add(item)
                deduped.append(item)
        return deduped


class OpenAIVisionProvider(VisionProvider):
    def __init__(self, model_override: str | None = None) -> None:
        if not settings.openai_api_key:
            raise RuntimeError("Missing OPENAI_API_KEY")
        self._model = (model_override or settings.openai_model).strip()

    def analyze(self, image_bytes: bytes, prompt: str) -> VisionResult:
        data_url = f"data:image/png;base64,{b64encode(image_bytes).decode('utf-8')}"
        payload = {
            "model": self._model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
        }
        response = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        raw = response.json()
        text = raw.get("output_text") or _extract_openai_text(raw)
        return VisionResult(
            text=(text or "").strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="chatgpt",
            model_name=self._model,
        )

    def stream(self, image_bytes: bytes, prompt: str) -> Generator[str, None, VisionResult]:
        result = self.analyze(image_bytes, prompt)
        for token in result.text.split(" "):
            yield f"{token} "
        return result

    def chat(self, prompt: str) -> VisionResult:
        payload = {
            "model": self._model,
            "input": prompt,
        }
        response = requests.post(
            "https://api.openai.com/v1/responses",
            headers={
                "Authorization": f"Bearer {settings.openai_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        raw = response.json()
        text = raw.get("output_text") or _extract_openai_text(raw)
        return VisionResult(
            text=(text or "").strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="chatgpt",
            model_name=self._model,
        )


class AnthropicVisionProvider(VisionProvider):
    def __init__(self, model_override: str | None = None) -> None:
        if not settings.anthropic_api_key:
            raise RuntimeError("Missing ANTHROPIC_API_KEY")
        self._model = (model_override or settings.anthropic_model).strip()

    def analyze(self, image_bytes: bytes, prompt: str) -> VisionResult:
        payload = {
            "model": self._model,
            "max_tokens": 1200,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": b64encode(image_bytes).decode("utf-8"),
                            },
                        },
                    ],
                }
            ],
        }
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        raw = response.json()
        text = _extract_anthropic_text(raw)
        return VisionResult(
            text=(text or "").strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="claude",
            model_name=self._model,
        )

    def stream(self, image_bytes: bytes, prompt: str) -> Generator[str, None, VisionResult]:
        result = self.analyze(image_bytes, prompt)
        for token in result.text.split(" "):
            yield f"{token} "
        return result

    def chat(self, prompt: str) -> VisionResult:
        payload = {
            "model": self._model,
            "max_tokens": 1200,
            "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
        }
        response = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        raw = response.json()
        text = _extract_anthropic_text(raw)
        return VisionResult(
            text=(text or "").strip(),
            confidence=0.9 if text else 0.2,
            raw=raw,
            provider="claude",
            model_name=self._model,
        )


def build_provider(mode: str | None, model_override: str | None = None) -> VisionProvider:
    chosen = (mode or settings.default_analysis_mode).lower()
    if chosen == "gemini":
        return GeminiVisionProvider(model_override=model_override)
    if chosen in {"chatgpt", "openai"}:
        return OpenAIVisionProvider(model_override=model_override)
    if chosen in {"claude", "anthropic"}:
        return AnthropicVisionProvider(model_override=model_override)
    return MockVisionProvider()


def _extract_openai_text(raw: dict) -> str:
    chunks = []
    for item in raw.get("output", []):
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                chunks.append(content.get("text", ""))
    return "\n".join([chunk for chunk in chunks if chunk])


def _extract_anthropic_text(raw: dict) -> str:
    chunks = []
    for item in raw.get("content", []):
        if item.get("type") == "text":
            chunks.append(item.get("text", ""))
    return "\n".join([chunk for chunk in chunks if chunk])


def _extract_gemini_text(raw: dict) -> str:
    chunks = []
    for candidate in raw.get("candidates", []):
        content = candidate.get("content", {})
        for part in content.get("parts", []):
            text = part.get("text")
            if text:
                chunks.append(text)
    return "\n".join(chunks)


def list_available_models(provider: str) -> list[str]:
    normalized = (provider or "").lower().strip()
    if normalized == "gemini":
        if not settings.gemini_api_key:
            return [settings.gemini_model]
        response = requests.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params={"key": settings.gemini_api_key},
            timeout=30,
        )
        response.raise_for_status()
        raw = response.json()
        names = []
        for item in raw.get("models", []):
            name = item.get("name", "")
            methods = item.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            if name.startswith("models/"):
                model_name = name.removeprefix("models/")
                lower = model_name.lower()
                if "audio" in lower or "tts" in lower or "embedding" in lower or "imagen" in lower:
                    continue
                names.append(model_name)
        return sorted(set(names)) or [settings.gemini_model]

    if normalized in {"chatgpt", "openai"}:
        if not settings.openai_api_key:
            return [settings.openai_model]
        response = requests.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            timeout=30,
        )
        response.raise_for_status()
        raw = response.json()
        names = []
        for item in raw.get("data", []):
            model_id = item.get("id", "")
            if not model_id:
                continue
            lower = model_id.lower()
            if not (lower.startswith("gpt-") or "o" in lower):
                continue
            if "embedding" in lower or "moderation" in lower or "whisper" in lower:
                continue
            names.append(model_id)
        return sorted(set(names)) or [settings.openai_model]

    if normalized in {"claude", "anthropic"}:
        if not settings.anthropic_api_key:
            return [settings.anthropic_model]
        response = requests.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
            },
            timeout=30,
        )
        response.raise_for_status()
        raw = response.json()
        names = [item.get("id", "") for item in raw.get("data", []) if item.get("id")]
        return sorted(set(names)) or [settings.anthropic_model]

    return ["mock-vision-v1"]
