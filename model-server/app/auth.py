"""Bearer 인증 (BR-MDL-02). 키는 환경변수 MODEL_API_KEY 에서만 읽는다. 키가 설정되지 않으면 모두 거부한다."""
from __future__ import annotations

import hmac

from fastapi import HTTPException, Request


def require_bearer(request: Request) -> None:
    expected: str | None = request.app.state.crd.settings.api_key
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if not expected or scheme.lower() != "bearer" or not hmac.compare_digest(token.strip().encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="인증 실패", headers={"WWW-Authenticate": "Bearer"})
