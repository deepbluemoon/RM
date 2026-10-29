// 모델 응답 정규화(T030) — 한국어 라벨·영문 코드를 data-model §2 DB 값으로. 모르는 값이면 판정을 거부한다
// (호출 측이 재시도 1회 뒤 unanalyzable 로 처리). "중간" 은 위험도에선 mid, 신뢰도에선 medium 이다.
import { CATEGORY_LABEL, CONFIDENCE_LABEL, RISK_LEVEL_LABEL, RISK_TYPE_LABEL, RISK_TYPES, CONTRACT_TYPES, CONTRACT_TYPE_LABEL, type Confidence, type ContractType, type RiskCategory, type RiskLevel, type RiskType } from '../../domain/codes.js';
import type { ModelJudgeResult } from '../../domain/types.js';
import type { JudgeResponse } from './client.js';

export class AdapterError extends Error {
  constructor(field: string) {
    super(`model label not recognized: ${field}`);
    this.name = 'AdapterError';
  }
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function reverse<T extends string>(labels: Record<T, string>, extra: Record<string, T> = {}): Map<string, T> {
  const m = new Map<string, T>();
  for (const [k, v] of Object.entries(labels) as [T, string][]) {
    m.set(norm(k), k);
    m.set(norm(v), k);
  }
  for (const [k, v] of Object.entries(extra)) m.set(norm(k), v);
  return m;
}

const CAT = reverse<RiskCategory | 'unanalyzable'>(CATEGORY_LABEL, { 불공정: 'unfair', 위법: 'illegal', 분쟁: 'dispute', 'dispute possible': 'dispute' });
const LEVEL = reverse<RiskLevel>(RISK_LEVEL_LABEL, { medium: 'mid', 보통: 'mid', 중: 'mid', 상: 'high', 하: 'low' });
const CONF = reverse<Confidence>(CONFIDENCE_LABEL, { 중간: 'medium', mid: 'medium', 중: 'medium', 상: 'high', 하: 'low' });
const TYPE = reverse<RiskType>(RISK_TYPE_LABEL, { '환불 제한': 'refund_cancel_limit', '해지 제한': 'refund_cancel_limit', 위약금: 'excessive_penalty', '과다 위약금': 'excessive_penalty', '일방 변경': 'unilateral_change', '면책': 'liability_avoid' });
const CT = reverse<ContractType>(CONTRACT_TYPE_LABEL, { 이커머스: 'ecommerce', 온라인쇼핑: 'ecommerce', 정기결제: 'subscription', 방문: 'door_to_door' });

export function normalizeJudge(r: JudgeResponse): ModelJudgeResult {
  const cat = CAT.get(norm(r.risk_class ?? ''));
  if (!cat || cat === 'unanalyzable') throw new AdapterError('risk_class');
  const claims = (r.explanation ?? []).map((c) => ({
    claim: String(c.claim ?? '').trim(),
    evidenceIds: (c.evidence_ids ?? []).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0),
  })).filter((c) => c.claim.length > 0);
  if (cat === 'normal') {
    return { category: 'normal', riskType: null, riskLevel: null, confidence: null, claims, modelVersion: r.model_version };
  }
  const riskType = r.risk_type ? TYPE.get(norm(r.risk_type)) : undefined;
  const riskLevel = r.risk_level ? LEVEL.get(norm(r.risk_level)) : undefined;
  const confidence = r.confidence ? CONF.get(norm(r.confidence)) : undefined;
  // BR-ANL-01: 정상이 아니면 세 값이 모두 있어야 한다 — 없거나 모르는 값이면 거부
  if (!riskType || !(RISK_TYPES as readonly string[]).includes(riskType)) throw new AdapterError('risk_type');
  if (!riskLevel) throw new AdapterError('risk_level');
  if (!confidence) throw new AdapterError('confidence');
  return { category: cat, riskType, riskLevel, confidence, claims, modelVersion: r.model_version };
}

/** M4 유형 후보 라벨 → contract_type_code 6종. 사상 실패는 null(사용자 직접 선택 — UC1 E8) */
export function normalizeContractType(label: string): ContractType | null {
  const v = CT.get(norm(label));
  return v && (CONTRACT_TYPES as readonly string[]).includes(v) ? v : null;
}

/** M1 유형 문자열 → risk_type (근거 검색 가중치 힌트용, 실패 시 null) */
export function normalizeRiskTypeHint(label: string | null | undefined): RiskType | null {
  return label ? (TYPE.get(norm(label)) ?? null) : null;
}
