# syntax=docker/dockerfile:1
# 모델 서버(FastAPI 게이트웨이) 이미지 — 규칙: docs/docker-image-policy.md
# 빌드 컨텍스트는 저장소 루트다(config.yaml 이 ../shared/assertion-terms.json 을 참조).
#   docker buildx build -f model-server/Dockerfile --platform linux/amd64,linux/arm64 \
#     -t moonsangjin/tamji:ms-<버전> .
# 빌드 전에 git lfs pull 로 M1·M2 가중치 실물을 받아야 한다(포인터만 있으면 models 단계에서 실패).

ARG PYTHON_IMAGE=python:3.11-slim-bookworm
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.6

FROM ${UV_IMAGE} AS uv

# 1) 의존성: uv.lock 그대로(--frozen), 개발 도구 제외, 분류기(torch CPU·transformers)와
#    Vertex(google-auth·requests — LLM_PROVIDER=vertex 일 때 M3·M4) 포함
FROM ${PYTHON_IMAGE} AS deps
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src
COPY model-server/pyproject.toml model-server/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra classifiers --extra vertex --no-install-project

# 2) 모델: 구동에 필요한 파일만(모델당 5개). LFS 포인터(수백 바이트)면 빌드를 멈춘다.
FROM ${PYTHON_IMAGE} AS models
WORKDIR /models
COPY model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/config.json \
     model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/model.safetensors \
     model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/model_card.json \
     model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/tokenizer.json \
     model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/tokenizer_config.json \
     m1-evasion-klue-roberta/
COPY model-server/var/models/model3/serving_ordneg/m2-illegal-klue-roberta/config.json \
     model-server/var/models/model3/serving_ordneg/m2-illegal-klue-roberta/model.safetensors \
     model-server/var/models/model3/serving_ordneg/m2-illegal-klue-roberta/model_card.json \
     model-server/var/models/model3/serving_ordneg/m2-illegal-klue-roberta/tokenizer.json \
     model-server/var/models/model3/serving_ordneg/m2-illegal-klue-roberta/tokenizer_config.json \
     m2-illegal-klue-roberta/
RUN for f in */model.safetensors; do \
      size=$(stat -c %s "$f"); \
      if [ "$size" -lt 1000000 ]; then echo "$f 가 Git LFS 포인터다($size bytes). git lfs pull 후 다시 빌드하라." >&2; exit 1; fi; \
    done

# 3) 실행: 의존성·코드·설정·모델만 담고 일반 사용자로 실행
FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app/model-server
COPY --from=deps /opt/venv /opt/venv
COPY model-server/app ./app
COPY model-server/schemas ./schemas
COPY model-server/config.yaml model-server/models.lock.yaml ./
COPY shared/assertion-terms.json /app/shared/assertion-terms.json
COPY --from=models /models ./var/models/model3/serving_ordneg
USER app
EXPOSE 9542
# MODEL_API_KEY 등 비밀값은 실행 시 환경 변수로 넣는다(이미지에 넣지 않음).
# Vertex 인증 정보(서비스 계정 키 등)도 이미지에 넣지 않고 실행 설정에서 연결한다(compose, #48).
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9542", "--workers", "1"]
