// 환경 변수 검증(T017). 누락·형식 오류면 기동을 실패시킨다. 값은 로그에 쓰지 않는다.
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
loadDotenv({ path: path.join(BACKEND_ROOT, '.env') });

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: num(9522),
  APP_BASE_URL: z.string().default('http://127.0.0.1:9502'),
  DB_HOST: z.string().min(1),
  DB_PORT: num(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  // 로그인(RBAC) — 세션 서명 키는 필수. 카카오·네이버는 키가 있을 때만 켜진다(없으면 로그인 화면에서 숨김)
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET 는 32자 이상'),
  KAKAO_CLIENT_ID: z.string().default(''),
  KAKAO_CLIENT_SECRET: z.string().default(''),
  NAVER_CLIENT_ID: z.string().default(''),
  NAVER_CLIENT_SECRET: z.string().default(''),
  OAUTH_REDIRECT_BASE: z.string().default('http://127.0.0.1:9502'),
  AUTH_DEV_PROVIDER: bool,
  RAW_STORAGE_DIR: z.string().default('./var/raw'),
  RAW_FILE_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'RAW_FILE_KEY 는 32바이트 hex(64자)'),
  // 기본값 없음(필수) — 빠지면 기동 실패. 8000 은 다른 계정 포트라 조용히 그리로 가면 조항·키가 샌다(API 점검 A10)
  MODEL_API_BASE_URL: z.string().url(),
  MODEL_API_KEY: z.string().min(1),
  MODEL_LLM_TIMEOUT_SEC: num(300),
  // 근거 검색 하이브리드(BM25 + bge-m3 코사인, RRF). off 면 BM25 만(벡터·게이트웨이 장애 때도 자동으로 BM25 만)
  RAG_HYBRID: z.enum(['on', 'off']).default('on'),
  // 하이브리드 튜닝(2026-09-30): 코사인 가중 RRF, 유사 공정위 사례의 근거 법조로 법령 확장, 상위 결과의 법령 최소 개수
  RAG_DENSE_WEIGHT: num(2),
  RAG_CASE_EXPAND: z.enum(['on', 'off']).default('on'),
  RAG_MIN_LAW: num(2),
  RAG_CASE_EXPAND_MODE: z.enum(['rank', 'vote']).default('rank'),  // 평가(2026-09-30): rank(사례별 누적) > vote
  RAG_PER_ARTICLE_MAX: num(1),
  RAG_CASE_EXPAND_TOP: num(20),
  // 근거 벡터 로컬 캐시(검색 인덱스 적재 전송량 절감). 테스트에서는 자동으로 꺼진다
  RAG_VEC_CACHE: z.enum(['on', 'off']).default('on'),
  RAG_VEC_CACHE_DIR: z.string().default('./var/cache/rag'),
  // 판정 불가 관문(2026-09-30). 관문 2 기준 = 정상 조항 오차단 1% 보정값(dataset_work/abstention/calibration_v1.json)
  ABSTAIN_ENABLED: z.enum(['on', 'off']).default('on'),
  ABSTAIN_LIKENESS_MIN: num(0.5388),
  DETECT_THRESHOLD_M1: num(0.5),
  DETECT_THRESHOLD_M2: num(0.5),
  ANON_SESSION_TTL_HOURS: num(24),
  ANALYSIS_CONCURRENCY: num(2),
  JUDGE_CONCURRENCY: num(1),
  LAW_API_OC: z.string().default(''),
  DATA_PORTAL_KEY: z.string().default(''),
  KNOWLEDGE_CRON: z.string().default(''),
  // P0 근거 수집(US7 T130) — 모두 선택. 키가 없으면 해당 기관 수집이 "키 미설정"으로 실패한다(G0)
  LAW_API_BASE_URL: z.string().default('https://www.law.go.kr/DRF'),
  DATA_PORTAL_STD_TERMS_URL: z.string().default(''),
  KCA_API_KEY: z.string().default(''),
  KCA_API_URL: z.string().default(''),
  KNOWLEDGE_COLLECT_TIMEOUT_SEC: num(30),
  KNOWLEDGE_STAGING_DIR: z.string().default('./var/knowledge'),
  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`환경 변수 오류 — backend/.env 확인: ${keys}`);
  }
  return parsed.data;
}

export const env: Env = load();

/** 개발용 로그인(dev 제공자) — AUTH_DEV_PROVIDER=true 이고 production 이 아닐 때만 */
export const devAuthEnabled = (): boolean => env.AUTH_DEV_PROVIDER && env.NODE_ENV !== 'production';
