# syntax=docker/dockerfile:1
# 백엔드(Express 웹 서버) 이미지 — 규칙: docs/docker-image-policy.md
# 빌드 컨텍스트는 저장소 루트다(실행 중 shared/·specs/·model-server/docs 를 읽는다).
#   docker buildx build -f backend/Dockerfile --platform linux/amd64,linux/arm64 \
#     -t moonsangjin/tamji:be-<버전> .
#
# 빌드 결과(dist/src·dist/scripts)는 실행 단계에서 /app/backend/src·scripts 로 둔다.
# config/env.ts 가 "자기 위치에서 두 단계 위"를 backend/ 로 보므로, 소스와 같은 구조여야
# .env·var/·shared/·specs/ 경로가 맞는다(빌드본 경로 버그 #55 는 별도로 고친다).

ARG NODE_IMAGE=node:20-bookworm-slim

# 1) 빌드: 개발 의존성까지 설치해 TypeScript 를 컴파일한다
FROM ${NODE_IMAGE} AS build
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/tsconfig.build.json ./
COPY backend/src ./src
# 운영 스크립트만 컴파일한다(픽스처 생성·평가 스크립트는 tests/ 를 참조해 이미지 대상이 아니다)
COPY backend/scripts/migrate.ts \
     backend/scripts/seed-knowledge.ts \
     backend/scripts/admin-create-account.ts \
     backend/scripts/admin-grant-role.ts \
     backend/scripts/ops-gates.ts \
     backend/scripts/ops-raw-retention.ts \
     ./scripts/
RUN npm run build

# 2) 운영 의존성: devDependencies 를 뺀 node_modules
FROM ${NODE_IMAGE} AS deps
WORKDIR /src/backend
COPY backend/package.json backend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# 3) 실행: 운영 의존성·빌드 결과·실행 중 읽는 파일만 담고 일반 사용자로 실행
FROM ${NODE_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --no-create-home app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=9522
WORKDIR /app/backend
COPY backend/package.json ./
COPY --from=deps /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/dist/src ./src
# 운영 스크립트: 마이그레이션·초기 지식 적재·계정·운영 점검 (node scripts/<이름>.js)
COPY --from=build /src/backend/dist/scripts ./scripts
COPY backend/db/migrations ./db/migrations
# 최초 지식 기준일 적재용(UC1 사전조건 — 이것 없이 분석을 시작할 수 없다)
COPY backend/tests/fixtures/knowledge/initial.json ./tests/fixtures/knowledge/initial.json
# 실행 중 읽는 저장소 파일: 설명 단정 표현 사전, 모델 API 계약(S9), 모델 서버 운영 문서(S9)
COPY shared/assertion-terms.json /app/shared/assertion-terms.json
COPY specs/002-contract-risk-detection/contracts/model-api.openapi.yaml /app/specs/002-contract-risk-detection/contracts/model-api.openapi.yaml
COPY model-server/docs/GUIDELINE.md model-server/docs/USER_MANUAL.md model-server/docs/service-test-result.json /app/model-server/docs/
COPY model-server/reports/baseline_v0/MODEL_TEST_REPORT.md /app/model-server/reports/baseline_v0/MODEL_TEST_REPORT.md
# 원본 파일 임시 보관·지식 스테이징·벡터 캐시(RAW_STORAGE_DIR 등 기본값 ./var/...). 운영에서는 볼륨으로 연결한다
RUN mkdir -p var/raw var/knowledge var/cache && chown -R app:app var
USER app
EXPOSE 9522
# DB 접속 정보·SESSION_SECRET·RAW_FILE_KEY·MODEL_API_KEY 등 비밀값은 실행 시 환경 변수로 넣는다(이미지에 넣지 않음).
CMD ["node", "--enable-source-maps", "src/server.js"]
