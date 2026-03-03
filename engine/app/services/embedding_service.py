from __future__ import annotations

import hashlib
from functools import lru_cache

try:
    from sentence_transformers import SentenceTransformer
except Exception:  # pragma: no cover - optional runtime fallback
    SentenceTransformer = None

from app.core.config import settings


class EmbeddingService:
    def __init__(self) -> None:
        self._fallback_dim = 384

    @lru_cache(maxsize=1)
    def _model(self):
        if SentenceTransformer is None:
            return None
        return SentenceTransformer(settings.embedding_model)

    def embed(self, text: str) -> list[float]:
        model = self._model()
        if model is not None:
            vector = model.encode(text, normalize_embeddings=True)
            return vector.tolist()
        return self._fallback_embed(text)

    def _fallback_embed(self, text: str) -> list[float]:
        digest = hashlib.sha256(text.encode("utf-8")).digest()
        raw = (digest * ((self._fallback_dim // len(digest)) + 1))[: self._fallback_dim]
        return [((byte / 255.0) * 2.0) - 1.0 for byte in raw]
