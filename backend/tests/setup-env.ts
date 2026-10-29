// 테스트 환경: DB_* 를 TEST_DB_* 로, 모델 API 는 프로세스 안에서 띄우는 스텁(포트 18611)으로 바꾼다.
// src/config/env.ts 가 읽기 전에 process.env 를 채운다(dotenv 는 이미 있는 값을 덮지 않는다)
import path from 'node:path';
import { config } from 'dotenv';
import { fileURLToPath as __f2p } from 'node:url';
const __dirname = path.dirname(__f2p(import.meta.url));

const parsed = config({ path: path.resolve(__dirname, '..', '.env') }).parsed ?? {};
const e = { ...parsed, ...process.env };
process.env.NODE_ENV = 'test';
process.env.DB_HOST = e.TEST_DB_HOST ?? '127.0.0.1';
process.env.DB_PORT = e.TEST_DB_PORT ?? '23610';
process.env.DB_USER = e.TEST_DB_USER ?? 'root';
process.env.DB_PASSWORD = e.TEST_DB_PASSWORD ?? '';
process.env.DB_NAME = e.TEST_DB_NAME ?? 'crd_test';
// 병렬 실행 시 TEST_DB_NAME·TEST_STUB_PORT 를 달리 주면 서로 부딪히지 않는다
process.env.TEST_STUB_PORT = e.TEST_STUB_PORT ?? '18611';
if (e.PERF_REAL_MODEL === '1') {
  // 성능 측정(tests/perf, T144)만 실모델 게이트웨이를 쓴다 — backend/.env 의 MODEL_API_BASE_URL·MODEL_API_KEY 그대로
  process.env.MODEL_API_BASE_URL = e.MODEL_API_BASE_URL;
  process.env.MODEL_API_KEY = e.MODEL_API_KEY;
} else {
  process.env.MODEL_API_BASE_URL = `http://127.0.0.1:${process.env.TEST_STUB_PORT}`;
  process.env.MODEL_API_KEY = 'test-model-key';
}
process.env.AUTH_DEV_PROVIDER = 'true';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-test-session-secret-0000';
process.env.RAW_STORAGE_DIR = path.resolve(__dirname, '..', 'var', 'raw-test');
process.env.MODEL_LLM_TIMEOUT_SEC = e.PERF_REAL_MODEL === '1' ? '300' : '30'; // 실모델은 공유 서버 대기 포함 300초(가이드 1.3)
process.env.JUDGE_CONCURRENCY = '1';
process.env.ANALYSIS_CONCURRENCY = '2';
