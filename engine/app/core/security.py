from __future__ import annotations

from fastapi import Depends, Header, HTTPException, status

from app.core.config import settings


def require_launch_token(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Missing bearer token", "retryable": False},
        )
    token = authorization.removeprefix("Bearer ").strip()
    if token != settings.launch_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "unauthorized", "message": "Invalid bearer token", "retryable": False},
        )


AuthDep = Depends(require_launch_token)
