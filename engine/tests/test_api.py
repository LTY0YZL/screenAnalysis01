from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)
AUTH = {"Authorization": "Bearer dev-token"}


def _sample_image() -> str:
    # 1x1 transparent PNG
    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0cIDATx\x9cc`\x00"
        b"\x00\x00\x02\x00\x01\xe2!\xbc3\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    return base64.b64encode(png).decode("utf-8")


def test_health():
    res = client.get("/v1/health")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["data"]["status"] == "ok"


def test_analyze_and_record_roundtrip():
    res = client.post(
        "/v1/analyze",
        headers=AUTH,
        json={
            "image_base64": _sample_image(),
            "prompt_template_id": "explain_code",
            "prompt_overrides": {"language": "python"},
            "metadata": {"source": "test"},
            "analysis_mode": "mock",
        },
    )
    assert res.status_code == 200
    data = res.json()["data"]
    record_id = data["record_id"]
    rec = client.get(f"/v1/records/{record_id}", headers=AUTH)
    assert rec.status_code == 200
    assert rec.json()["data"]["id"] == record_id


def test_auth_required():
    res = client.post("/v1/search", json={"query": "anything", "top_k": 3})
    assert res.status_code == 401
