// policy_constant 로더(T017). status=unknown(값 NULL)이면 env 기본값을 쓰고 기동 로그에 경고한다(research R-15 #18·#5).
import { getPool, select } from '../db/pool.js';
import { env } from './env.js';
import { logger } from '../logger.js';

interface PolicyRow {
  const_key: string;
  value_num: number | null;
  status: 'confirmed' | 'assumed' | 'unknown';
}

const ENV_FALLBACK: Record<string, () => number | null> = {
  DETECT_THRESHOLD_M1: () => env.DETECT_THRESHOLD_M1,
  DETECT_THRESHOLD_M2: () => env.DETECT_THRESHOLD_M2,
  ANON_SESSION_TTL_HOURS: () => env.ANON_SESSION_TTL_HOURS,
  EVAL_MIN_CLAUSES_PER_TYPE: () => null,
  REFLECT_WARN_DAYS: () => null,
};

const DEFAULTS: Record<string, number> = {
  FREE_MONTHLY_LIMIT: 3,
  FILE_MAX_MB: 50,
  FILE_MAX_PAGES: 300,
  RAW_RETENTION_HOURS: 24,
  KNW_REFLECT_DAYS: 7,
  BIAS_GAP_PP: 15,
  SC_RECALL_PCT: 85,
  SC_PRECISION_PCT: 70,
  SC_EVIDENCE_FIT_PCT: 90,
  MODEL_TIMEOUT_SEC: 30,
  MODEL_RETRY: 1,
};

let values: Record<string, number | null> = { ...DEFAULTS, DETECT_THRESHOLD_M1: env.DETECT_THRESHOLD_M1, DETECT_THRESHOLD_M2: env.DETECT_THRESHOLD_M2, ANON_SESSION_TTL_HOURS: env.ANON_SESSION_TTL_HOURS };
const warned = new Set<string>();

export async function loadPolicy(): Promise<void> {
  const rows = await select<PolicyRow>(getPool(), 'SELECT const_key, value_num, status FROM policy_constant');
  const next: Record<string, number | null> = { ...DEFAULTS };
  for (const r of rows) {
    if (r.status === 'unknown' || r.value_num === null) {
      const fb = ENV_FALLBACK[r.const_key]?.() ?? null;
      next[r.const_key] = fb;
      if (!warned.has(r.const_key)) {
        warned.add(r.const_key);
        logger.warn({ key: r.const_key, fallback: fb }, 'policy_constant 값 미확정 — env 기본값 사용');
      }
    } else {
      next[r.const_key] = Number(r.value_num);
    }
  }
  values = next;
}

export function policy(key: string): number {
  const v = values[key];
  if (v === null || v === undefined) throw new Error(`정책 값 없음: ${key}`);
  return v;
}

export function policyOrNull(key: string): number | null {
  return values[key] ?? null;
}
