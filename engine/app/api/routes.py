from __future__ import annotations

import asyncio
import base64
import os
import signal

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from mss import mss, tools
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import require_launch_token
from app.db import SessionLocal, get_db
from app.models.prompt_template import PromptTemplate
from app.models.record import Record
from app.schemas import AnalyzeRequest, ChatRequest, EmbedRequest, SearchRequest
from app.services.analysis_service import AnalysisService
from app.services.embedding_service import EmbeddingService
from app.services.prompt_service import PromptService
from app.services.vector_service import VectorService
from app.services.vision_provider import list_available_models

router = APIRouter(prefix="/v1", tags=["v1"])

embedding_service = EmbeddingService()
vector_service = VectorService()
analysis_service = AnalysisService(embedding_service=embedding_service, vector_service=vector_service)


def ok(data):
    return {"ok": True, "data": data}


def fail(code: str, message: str, retryable: bool = False):
    return {"ok": False, "error": {"code": code, "message": message, "retryable": retryable}}


@router.get("/health")
def health():
    return ok({"status": "ok", "pid": os.getpid(), "version": settings.app_version})


@router.post("/analyze")
def analyze(payload: AnalyzeRequest, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    PromptService.ensure_seed_templates(db)
    try:
        return ok(analysis_service.analyze(db, payload))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=fail("bad_request", str(exc)))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=fail("analyze_failed", str(exc), retryable=True))


@router.post("/embed")
def embed(payload: EmbedRequest, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    try:
        return ok(analysis_service.embed_text(db, payload.text, payload.record_id))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=fail("embed_failed", str(exc), retryable=True))


@router.post("/search")
def search(payload: SearchRequest, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    return ok(analysis_service.search(db, payload.query, payload.top_k))


@router.post("/chat")
def chat(payload: ChatRequest, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    try:
        return ok(analysis_service.chat_followup(db, payload))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=fail("chat_failed", str(exc), retryable=True))


@router.post("/reindex")
def reindex(db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    return ok(analysis_service.reindex_all(db))


@router.post("/capture-region")
def capture_region(payload: dict, _: None = Depends(require_launch_token)):
    try:
        left = int(payload.get("x", 0))
        top = int(payload.get("y", 0))
        width = max(1, int(payload.get("width", 1)))
        height = max(1, int(payload.get("height", 1)))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail=fail("bad_request", "Invalid capture bounds"))

    region = {"left": left, "top": top, "width": width, "height": height}
    with mss() as sct:
        image = sct.grab(region)
        png_bytes = tools.to_png(image.rgb, image.size)
    return ok({"image_base64": base64.b64encode(png_bytes).decode("utf-8")})


@router.get("/records")
def list_records(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
    _: None = Depends(require_launch_token),
):
    records = analysis_service.list_records(db, limit=limit, offset=offset)
    return ok([analysis_service.record_to_dict(record, include_image=False) for record in records])


@router.get("/records/{record_id}")
def get_record(record_id: int, include_image: bool = True, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    record = db.get(Record, record_id)
    if not record:
        raise HTTPException(status_code=404, detail=fail("not_found", "Record not found"))
    return ok(analysis_service.record_to_dict(record, include_image=include_image))


@router.delete("/records/{record_id}")
def delete_record(record_id: int, db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    deleted = analysis_service.delete_record(db, record_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=fail("not_found", "Record not found"))
    return ok({"deleted": True, "record_id": record_id})


@router.get("/templates")
def list_templates(db: Session = Depends(get_db), _: None = Depends(require_launch_token)):
    PromptService.ensure_seed_templates(db)
    items = db.query(PromptTemplate).order_by(PromptTemplate.name.asc()).all()
    return ok([{"id": item.id, "name": item.name, "template": item.template} for item in items])


@router.get("/providers/models")
def provider_models(provider: str = Query(default="gemini"), _: None = Depends(require_launch_token)):
    try:
        models = list_available_models(provider)
        return ok({"provider": provider, "models": models})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=fail("models_failed", str(exc), retryable=True))


@router.post("/shutdown")
async def shutdown(_: None = Depends(require_launch_token)):
    async def _stop():
        await asyncio.sleep(0.2)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_stop())
    return ok({"status": "shutting_down"})


@router.websocket("/ws/analyze")
async def ws_analyze(websocket: WebSocket):
    await websocket.accept()
    db = SessionLocal()
    try:
        while True:
            payload = await websocket.receive_json()
            token = payload.get("token", "")
            if token != settings.launch_token:
                await websocket.send_json(fail("unauthorized", "Invalid token", retryable=False))
                continue
            body = payload.get("payload", {})
            req = AnalyzeRequest.model_validate(body)
            await websocket.send_json({"ok": True, "event": "start"})
            for event in analysis_service.stream_analyze(db, req):
                await websocket.send_json({"ok": True, "event": event["type"], "data": event})
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await websocket.send_json(fail("ws_error", str(exc), retryable=True))
    finally:
        db.close()
