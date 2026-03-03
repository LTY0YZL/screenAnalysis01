# Electron <> Engine Process Management

1. Electron main process allocates a random local port and per-launch bearer token.
2. Electron spawns Python engine (`engine/main.py`) with environment:
   - `SCREENANALYSIS_PORT`
   - `SCREENANALYSIS_HOST`
   - `SCREENANALYSIS_LAUNCH_TOKEN`
3. Electron polls `GET /v1/health` until engine is ready.
4. Renderer never receives launch token directly; renderer uses IPC bridge in `preload.cjs`.
5. On app exit, Electron calls `POST /v1/shutdown`, then force-kills child as fallback.
6. If child crashes unexpectedly, Electron auto-restarts with capped retries.
