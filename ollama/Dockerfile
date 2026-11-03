# syntax=docker/dockerfile:1
# 임베딩 전용 Ollama (slim) — 규칙: docs/docker-image-policy.md
# 공식 ollama/ollama 에서 CPU 추론에 필요한 것만 추출해 debian-slim 에 얹는다.
# GPU 러너(cuda_v12·cuda_v13·mlx_cuda_v13·vulkan, 합계 약 4.4GB)를 빼면 이미지가 10.7GB → 2.44GB 로 줄고,
# bge-m3 임베딩은 CPU 로만 하므로 동작에 영향이 없다(실측 2026-11-03, amd64). 2.44GB 의 대부분(약 1.1GB)은 bge-m3 모델이다.
#   docker buildx build -f ollama/Dockerfile --platform linux/amd64,linux/arm64 -t moonsangjin/tamji:ol-<버전> .
# 교차아치(arm64) 빌드는 빌드 단계에서 ollama 를 QEMU 로 실행하므로 느리다. 확인하지 않은 플랫폼은 지원한다고 적지 않는다(§3).
# 베이스는 멀티아치(amd64+arm64) 태그를 digest 까지 고정한다(§4). 버전을 올리면 러너 경로·동작을 다시 확인한다.

ARG OLLAMA_IMAGE=ollama/ollama:0.40.13@sha256:b2f0122c476bc9fe7ce679d8bb4bd555351e25e2554eefb156f61cb0a89cf429
ARG DEBIAN_IMAGE=debian:bookworm-slim
ARG EMBED_MODEL=bge-m3

# 추출 원본(공식 이미지)
FROM ${OLLAMA_IMAGE} AS vendor

# 1) 굽기: GPU 러너를 지운 CPU 전용 상태에서 ollama serve 를 띄워 모델을 받아 /models 에 저장한다.
#    (여기서 받아지면 런타임의 CPU 전용 구성에서도 동작한다는 뜻이다.)
FROM ${DEBIAN_IMAGE} AS bake
ARG EMBED_MODEL
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=vendor /usr/bin/ollama /usr/bin/ollama
COPY --from=vendor /usr/lib/ollama /usr/lib/ollama
# GPU 러너 제거 — CPU 임베딩에 불필요하다(이미지의 대부분을 차지한다). 아키텍처마다 디렉터리 이름이 달라
# cuda*·rocm*·mlx*·vulkan 을 glob 으로 지운다(없으면 rm -rf 가 조용히 넘어간다). CPU 러너(libggml-cpu-*)는 남긴다.
RUN rm -rf /usr/lib/ollama/cuda_v* /usr/lib/ollama/cuda* /usr/lib/ollama/rocm* \
           /usr/lib/ollama/mlx* /usr/lib/ollama/vulkan /usr/lib/ollama/include
ENV OLLAMA_MODELS=/models
RUN set -eu; \
    ollama serve & \
    pid=$!; \
    ready=; \
    for _ in $(seq 1 60); do if ollama list >/dev/null 2>&1; then ready=1; break; fi; sleep 1; done; \
    [ -n "$ready" ] || { echo "ollama serve 가 뜨지 않았다" >&2; exit 1; }; \
    ollama pull "${EMBED_MODEL}"; \
    ollama list; \
    kill "$pid" 2>/dev/null || true; \
    wait "$pid" 2>/dev/null || true

# 2) 실행: debian-slim + 바이너리 + CPU 러너 + 구운 모델만. 고정 UID/GID 의 비루트로 실행(§4).
#    /root/.ollama 가 아니라 /models 에 모델을 둔다 — 런타임에 볼륨으로 /models 를 덮지 않는다.
FROM ${DEBIAN_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /home/app --create-home app
COPY --from=vendor /usr/bin/ollama /usr/bin/ollama
COPY --from=bake /usr/lib/ollama /usr/lib/ollama
COPY --from=bake --chown=10001:10001 /models /models
ENV HOME=/home/app \
    OLLAMA_MODELS=/models \
    OLLAMA_HOST=0.0.0.0:11434
USER 10001:10001
EXPOSE 11434
# 비밀값 없음(공개 모델만). 포트는 compose 내부 네트워크로만 연다.
ENTRYPOINT ["/usr/bin/ollama"]
CMD ["serve"]
