// 브랜드 타입과 공용 도메인 타입(T019, data-model §6)
import type { ContractType, Confidence, Perspective, RiskCategory, RiskLevel, RiskType } from './codes.js';

declare const deidBrand: unique symbol;
/**
 * 비식별화를 거친 텍스트. deid.service.ts#deidentify 만 이 타입을 만든다(CLAUDE.md, BR-MDL-01).
 * DB 저장·로그·모델 API 인자는 이 타입만 받는다.
 */
export type DeidentifiedText = string & { readonly [deidBrand]: true };

declare const kvBrand: unique symbol;
/** 지식 기준일 ID — 근거 검색의 필수 인자(A4) */
export type KvId = number & { readonly [kvBrand]: true };
export const asKvId = (n: number): KvId => n as KvId;

/** DB 에서 읽은 비식별 텍스트(이미 비식별화되어 저장된 값)만 브랜드를 붙인다 — clause.deid_text 등 */
export const fromStoredDeid = (s: string): DeidentifiedText => s as DeidentifiedText;

export interface Owner {
  userId: number | null;
  sessionId: string | null;
  deviceKey: string | null;
}

export interface ModelClaim {
  claim: string;
  evidenceIds: number[];
}

export interface ModelJudgeResult {
  category: RiskCategory;
  riskType: RiskType | null;
  riskLevel: RiskLevel | null;
  confidence: Confidence | null;
  claims: ModelClaim[];
  modelVersion: string;
}

export interface JudgeInput {
  clause: DeidentifiedText;
  contractType: ContractType;
  perspective: Perspective;
  knowledgeDate: string;
  scores: { loophole: number | null; illegal: number | null };
  evidence: { id: number; sourceType: string; title: string; text: string }[];
}
