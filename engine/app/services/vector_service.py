from __future__ import annotations

from uuid import uuid4

try:
    import chromadb
except Exception:  # pragma: no cover - optional runtime fallback
    chromadb = None

from app.core.config import settings


class VectorService:
    def __init__(self) -> None:
        self._mem_vectors: dict[str, dict] = {}
        self._collection = None
        if chromadb is not None:
            client = chromadb.PersistentClient(path=str(settings.chroma_dir))
            self._collection = client.get_or_create_collection(name=settings.chroma_collection)

    def add(self, vector: list[float], metadata: dict, text: str, vector_id: str | None = None) -> str:
        vid = vector_id or f"vec-{uuid4()}"
        if self._collection is not None:
            self._collection.add(ids=[vid], embeddings=[vector], metadatas=[metadata], documents=[text])
        else:
            self._mem_vectors[vid] = {"embedding": vector, "metadata": metadata, "document": text}
        return vid

    def query(self, vector: list[float], top_k: int) -> list[dict]:
        if self._collection is not None:
            result = self._collection.query(query_embeddings=[vector], n_results=top_k)
            ids = result.get("ids", [[]])[0]
            dists = result.get("distances", [[]])[0]
            metas = result.get("metadatas", [[]])[0]
            docs = result.get("documents", [[]])[0]
            rows = []
            for idx, vid in enumerate(ids):
                score = 1.0 / (1.0 + float(dists[idx])) if idx < len(dists) else 0.0
                rows.append({"id": vid, "score": score, "metadata": metas[idx] if idx < len(metas) else {}, "document": docs[idx]})
            return rows
        return self._query_fallback(vector, top_k)

    def delete(self, vector_id: str) -> None:
        if not vector_id:
            return
        if self._collection is not None:
            self._collection.delete(ids=[vector_id])
            return
        self._mem_vectors.pop(vector_id, None)

    def _query_fallback(self, vector: list[float], top_k: int) -> list[dict]:
        scored = []
        for vid, payload in self._mem_vectors.items():
            score = _cosine(vector, payload["embedding"])
            scored.append({"id": vid, "score": score, "metadata": payload["metadata"], "document": payload["document"]})
        scored.sort(key=lambda row: row["score"], reverse=True)
        return scored[:top_k]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    num = sum(a[i] * b[i] for i in range(n))
    den_a = sum(a[i] * a[i] for i in range(n)) ** 0.5
    den_b = sum(b[i] * b[i] for i in range(n)) ** 0.5
    if den_a == 0 or den_b == 0:
        return 0.0
    return num / (den_a * den_b)
