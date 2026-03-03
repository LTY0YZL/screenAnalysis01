from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import settings
from app.db import Base, engine
from app.services.prompt_service import PromptService
from app.db import SessionLocal


def create_app() -> FastAPI:
    app = FastAPI(title=settings.app_name, version=settings.app_version)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _startup():
        Base.metadata.create_all(bind=engine)
        db = SessionLocal()
        try:
            PromptService.ensure_seed_templates(db)
        finally:
            db.close()

    @app.exception_handler(Exception)
    async def _unhandled_exception_handler(_: Request, exc: Exception):
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": {"code": "internal_error", "message": str(exc), "retryable": False}},
        )

    app.include_router(router)
    return app
