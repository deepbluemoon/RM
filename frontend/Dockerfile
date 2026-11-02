# syntax=docker/dockerfile:1
# 프런트엔드 이미지 — 규칙: docs/docker-image-policy.md
# 빌드 컨텍스트는 저장소 루트다(다른 이미지와 같은 방식).
#   docker buildx build -f frontend/Dockerfile --platform linux/amd64,linux/arm64 \
#     -t moonsangjin/tamji:fe-<버전> .
# 실행 시 BACKEND_URL 로 /api 를 넘길 백엔드 주소를 바꿀 수 있다(기본 http://backend:9522).

ARG NODE_IMAGE=node:20-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

# 1) 빌드: 타입 검사(vue-tsc) 후 vite 로 정적 파일을 만든다
FROM ${NODE_IMAGE} AS build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY frontend/index.html frontend/vite.config.ts frontend/tsconfig.json ./
COPY frontend/public ./public
COPY frontend/src ./src
RUN npm run build

# 2) 실행: 일반 사용자 nginx(UID 101)가 빌드 결과만 내보낸다
FROM ${NGINX_IMAGE} AS runtime
ENV BACKEND_URL=http://backend:9522 \
    NGINX_ENVSUBST_FILTER=^BACKEND_URL$
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/frontend/dist /usr/share/nginx/html
EXPOSE 8080
