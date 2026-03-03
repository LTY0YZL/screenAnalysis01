from __future__ import annotations

import base64
import hashlib
from pathlib import Path

from app.core.config import settings


def save_image_from_base64(image_base64: str) -> Path:
    image_bytes = base64.b64decode(image_base64)
    digest = hashlib.sha256(image_bytes).hexdigest()
    file_path = settings.images_dir / f"{digest}.png"
    if not file_path.exists():
        file_path.write_bytes(image_bytes)
    return file_path


def read_image_base64(image_path: str) -> str | None:
    path = Path(image_path)
    if not path.exists():
        return None
    return base64.b64encode(path.read_bytes()).decode("utf-8")
