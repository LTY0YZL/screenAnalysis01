from __future__ import annotations

import uvicorn

from app.app import create_app
from app.core.config import settings

app = create_app()


if __name__ == "__main__":
    print(f"Starting {settings.app_name} on {settings.host}:{settings.port}")
    uvicorn.run(app, host=settings.host, port=settings.port, reload=False)
