from __future__ import annotations

import base64
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.models.analysis_run import AnalysisRun
from app.models.record import Record
from app.schemas import AnalyzeRequest, ChatRequest
from app.services.embedding_service import EmbeddingService
from app.services.file_service import read_image_base64, save_image_from_base64
from app.services.prompt_service import PromptService
from app.services.vector_service import VectorService
from app.services.vision_provider import VisionResult, build_provider


class AnalysisService:
    def __init__(self, embedding_service: EmbeddingService, vector_service: VectorService) -> None:
        self.embedding_service = embedding_service
        self.vector_service = vector_service

    def analyze(self, db: Session, payload: AnalyzeRequest) -> dict[str, Any]:
        image_bytes = self._decode(payload.image_base64)
        image_path = save_image_from_base64(payload.image_base64)
        template_id, template_name, template_text = PromptService.get_template_text(db, payload.prompt_template_id)
        prompt = PromptService.render(template_text, payload.prompt_overrides)
        prompt = self._enrich_prompt(prompt, payload.metadata, payload.prompt_overrides)

        start = time.perf_counter()
        result, retry_count = self._analyze_with_retry(
            image_bytes, prompt, payload.analysis_mode, payload.model_override
        )
        latency_ms = int((time.perf_counter() - start) * 1000)

        searchable_text = self._build_searchable_text(result.text, prompt, payload.metadata)
        record_metadata = {
            **(payload.metadata or {}),
            "provider": result.provider,
            "model_name": result.model_name,
        }
        record = Record(
            image_path=str(image_path),
            ocr_text=None,
            model_text=result.text,
            model_raw=result.raw,
            metadata_json=record_metadata,
            searchable_text=searchable_text,
            prompt_template_id=template_id,
            prompt_template_name=template_name,
            prompt_text=prompt,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

        vector = self.embedding_service.embed(searchable_text)
        embedding_id = self.vector_service.add(
            vector=vector,
            metadata={
                "record_id": record.id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "snippet": searchable_text[:200],
                "prompt_template_name": template_name or "default",
                "source": payload.metadata.get("source", "unknown"),
            },
            text=searchable_text,
        )
        record.embedding_id = embedding_id
        db.add(record)

        run = AnalysisRun(
            record_id=record.id,
            provider=result.provider,
            model_name=result.model_name,
            latency_ms=latency_ms,
            status="success",
            retry_count=retry_count,
            request_metadata=payload.metadata,
            retryable=False,
        )
        db.add(run)
        db.commit()
        db.refresh(record)

        return {
            "record_id": record.id,
            "model_text": record.model_text,
            "ocr_text": record.ocr_text,
            "embedding_id": record.embedding_id,
            "confidence": result.confidence,
            "provider": result.provider,
            "model_name": result.model_name,
            "raw_model_response": result.raw,
        }

    def stream_analyze(self, db: Session, payload: AnalyzeRequest):
        image_bytes = self._decode(payload.image_base64)
        image_path = save_image_from_base64(payload.image_base64)
        template_id, template_name, template_text = PromptService.get_template_text(db, payload.prompt_template_id)
        prompt = PromptService.render(template_text, payload.prompt_overrides)
        prompt = self._enrich_prompt(prompt, payload.metadata, payload.prompt_overrides)
        provider = build_provider(payload.analysis_mode, payload.model_override)

        chunks: list[str] = []
        generator = provider.stream(image_bytes, prompt)
        result = None
        while True:
            try:
                chunk = next(generator)
                chunks.append(chunk)
                yield {"type": "partial", "text": chunk}
            except StopIteration as stop:
                result = stop.value
                break
        if result is None:
            result = VisionResult(
                text="".join(chunks),
                confidence=0.7,
                raw={"stream_fallback": True},
                provider="mock",
                model_name="mock-vision-v1",
            )

        searchable_text = self._build_searchable_text(result.text, prompt, payload.metadata)
        record_metadata = {
            **(payload.metadata or {}),
            "provider": result.provider,
            "model_name": result.model_name,
        }
        record = Record(
            image_path=str(image_path),
            ocr_text=None,
            model_text=result.text,
            model_raw=result.raw,
            metadata_json=record_metadata,
            searchable_text=searchable_text,
            prompt_template_id=template_id,
            prompt_template_name=template_name,
            prompt_text=prompt,
        )
        db.add(record)
        db.commit()
        db.refresh(record)

        vector = self.embedding_service.embed(searchable_text)
        embedding_id = self.vector_service.add(
            vector=vector,
            metadata={
                "record_id": record.id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "snippet": searchable_text[:200],
                "prompt_template_name": template_name or "default",
                "source": payload.metadata.get("source", "unknown"),
            },
            text=searchable_text,
        )
        record.embedding_id = embedding_id
        db.add(record)
        db.commit()
        db.refresh(record)
        yield {
            "type": "final",
            "record_id": record.id,
            "model_text": record.model_text,
            "embedding_id": embedding_id,
            "confidence": result.confidence,
            "provider": result.provider,
            "model_name": result.model_name,
        }

    def search(self, db: Session, query: str, top_k: int) -> list[dict[str, Any]]:
        vector = self.embedding_service.embed(query)
        matches = self.vector_service.query(vector, top_k=max(1, min(top_k, 25)))
        results = []
        for match in matches:
            metadata = match.get("metadata", {})
            record_id = metadata.get("record_id")
            if record_id is None:
                continue
            record = db.get(Record, int(record_id))
            if not record:
                continue
            results.append(
                {
                    "record_id": record.id,
                    "score": round(float(match.get("score", 0.0)), 4),
                    "snippet": (record.searchable_text or "")[:200],
                }
            )
        return results

    def embed_text(self, db: Session, text: str, record_id: int | None = None) -> dict[str, Any]:
        vector = self.embedding_service.embed(text)
        metadata = {
            "record_id": record_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "snippet": text[:200],
            "prompt_template_name": "manual_embed",
            "source": "manual",
        }
        embedding_id = self.vector_service.add(vector=vector, metadata=metadata, text=text)
        if record_id:
            record = db.get(Record, record_id)
            if record:
                record.embedding_id = embedding_id
                db.add(record)
                db.commit()
        return {"embedding_id": embedding_id, "vector_dim": len(vector)}

    def reindex_all(self, db: Session) -> dict[str, Any]:
        records = db.execute(select(Record)).scalars().all()
        updated = 0
        for record in records:
            if not record.searchable_text:
                continue
            vector = self.embedding_service.embed(record.searchable_text)
            metadata = {
                "record_id": record.id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "snippet": record.searchable_text[:200],
                "prompt_template_name": record.prompt_template_name or "default",
                "source": (record.metadata_json or {}).get("source", "reindex"),
            }
            embedding_id = self.vector_service.add(vector=vector, metadata=metadata, text=record.searchable_text)
            record.embedding_id = embedding_id
            db.add(record)
            updated += 1
        db.commit()
        return {"reindexed": updated, "total": len(records)}

    def chat_followup(self, db: Session, payload: ChatRequest) -> dict[str, Any]:
        message_id = (payload.message_id or "").strip()
        records = self.list_records(db, limit=200, offset=0)
        context_records = []
        if message_id:
            for record in records:
                meta = record.metadata_json or {}
                if str(meta.get("message_id", "")).strip() == message_id:
                    context_records.append(record)
        if not context_records and records:
            context_records = records[:6]
        context_records.sort(key=lambda item: item.created_at or datetime.min.replace(tzinfo=timezone.utc))
        context_text = "\n\n".join(
            [
                f"[Record {record.id}] Purpose: {(record.metadata_json or {}).get('purpose_text', '')}\n"
                f"Prompt: {record.prompt_text}\n"
                f"Response: {record.model_text or ''}"
                for record in context_records[-8:]
            ]
        )
        final_prompt = (
            "You are continuing a conversation about previously captured screenshots.\n"
            "Use the context below and answer the user's follow-up question precisely.\n"
            "If context is insufficient, say exactly what is missing.\n\n"
            f"Context:\n{context_text}\n\n"
            f"Extra context from user:\n{payload.extra_context or ''}\n\n"
            f"User question:\n{payload.question}\n"
        )
        provider = build_provider(payload.analysis_mode, payload.model_override)
        result = provider.chat(final_prompt)
        return {
            "message_id": message_id or None,
            "question": payload.question,
            "reply_text": result.text,
            "provider": result.provider,
            "model_name": result.model_name,
            "context_records": [record.id for record in context_records[-8:]],
        }

    @staticmethod
    def list_records(db: Session, limit: int = 50, offset: int = 0) -> list[Record]:
        stmt = select(Record).order_by(desc(Record.created_at)).offset(max(offset, 0)).limit(max(1, min(limit, 200)))
        return list(db.execute(stmt).scalars().all())

    @staticmethod
    def record_to_dict(record: Record, include_image: bool = False) -> dict[str, Any]:
        return {
            "id": record.id,
            "created_at": record.created_at.isoformat() if record.created_at else None,
            "image_path": record.image_path,
            "image_base64": read_image_base64(record.image_path) if include_image else None,
            "ocr_text": record.ocr_text,
            "model_text": record.model_text,
            "prompt_template_id": record.prompt_template_id,
            "prompt_template_name": record.prompt_template_name,
            "prompt_text": record.prompt_text,
            "metadata": record.metadata_json,
            "embedding_id": record.embedding_id,
        }

    def delete_record(self, db: Session, record_id: int) -> bool:
        record = db.get(Record, record_id)
        if not record:
            return False
        if record.embedding_id:
            self.vector_service.delete(record.embedding_id)
        image_path = Path(record.image_path)
        if image_path.exists():
            try:
                image_path.unlink()
            except OSError:
                pass
        db.delete(record)
        db.commit()
        return True

    @staticmethod
    def _decode(image_base64: str) -> bytes:
        try:
            return base64.b64decode(image_base64)
        except Exception as exc:
            raise ValueError("Invalid image_base64 payload") from exc

    @staticmethod
    def _build_searchable_text(model_text: str, prompt: str, metadata: dict[str, Any]) -> str:
        return f"Prompt: {prompt}\nResponse: {model_text}\nMetadata: {metadata}"

    @staticmethod
    def _enrich_prompt(prompt: str, metadata: dict[str, Any], overrides: dict[str, Any]) -> str:
        purpose = metadata.get("purpose_text") or overrides.get("task") or overrides.get("content") or ""
        if not purpose:
            return prompt
        return (
            f"{prompt}\n\n"
            "User intent for this screenshot:\n"
            f"{purpose}\n"
            "Prioritize answering exactly this intent."
        )

    @staticmethod
    def _analyze_with_retry(
        image_bytes: bytes, prompt: str, mode: str | None, model_override: str | None = None
    ) -> tuple[VisionResult, int]:
        retries = 2
        sleep = 0.5
        for attempt in range(retries + 1):
            provider = build_provider(mode, model_override=model_override)
            try:
                return provider.analyze(image_bytes, prompt), attempt
            except Exception:
                if attempt >= retries:
                    raise
                time.sleep(sleep)
                sleep *= 2
