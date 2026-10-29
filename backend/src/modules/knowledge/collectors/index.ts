// 0.1 변경분 수집기 공통 인터페이스(T130). 4개 기관을 병렬로 부르고 기관별 결과를 ingest_source_status 에 남긴다.
// 키는 env 로만 받는다. 테스트는 setCollectors() 로 목(mock) 수집기를 주입한다 — 실제 네트워크 호출 없음
import { env } from '../../../config/env.js';
import { lawCenterCollector } from './lawCenter.js';
import { ftcCollector } from './ftc.js';
import { dataPortalCollector } from './dataPortal.js';
import { kcaCollector } from './kca.js';

/** ingest_source_status.agency · ingest_item.agency (chk_iss_agency) */
export type Agency = 'law_center' | 'ftc' | 'data_portal' | 'kca';
export const AGENCIES: Agency[] = ['law_center', 'ftc', 'data_portal', 'kca'];
export const AGENCY_LABEL: Record<Agency, string> = {
  law_center: '국가법령정보센터',
  ftc: '공정거래위원회',
  data_portal: '공공데이터포털',
  kca: '한국소비자원',
};

/** ingest_item.change_kind (chk_ii_change) */
export type ChangeKind = 'amend' | 'repeal' | 'new_law' | 'new_case' | 'std_terms_revision' | 'reference';

/** 수집 기준 — 현재 활성 기준일. 최초 적재는 null(UC7 사전조건 2) */
export interface SinceKv {
  kvId: number;
  knowledgeDate: string;
}

/**
 * 원천 변경분 1건(0.1 Output). 법령은 조 단위, 사례는 사건 단위, 표준약관은 조항 단위.
 * 공개 자료(법령·의결·표준약관)만 다룬다 — 이용자 계약 원문은 여기 오지 않는다.
 */
export interface SourceDelta {
  agency: Agency;
  changeKind: ChangeKind;
  /** 근거 유형(evidence_item.source_type). 소비자원 참고 자료는 근거가 아니므로 null(FR-021) */
  sourceType: 'law_article' | 'ftc_case' | 'std_terms' | null;
  /** 법령명·사건명·표준약관명 (BR-EVD-02) */
  sourceName: string;
  /** 법령은 조 번호("제6조", "제21조의2"), 사례는 사건번호, 표준약관은 조항("제15조(청약철회 등)") */
  identifier: string;
  /** S0 반영 대상 표의 항목명 */
  title: string;
  /** 조문 전문(항·호 포함) 또는 사례 전문 */
  rawText: string;
  /** 원천이 이미 나눠 준 사례 3구분(있으면 그대로 쓴다) */
  caseSections?: { facts?: string | null; judgment?: string | null; basis?: string | null } | null;
  sourceUrl: string;
  effectiveDate?: string | null;
  publishedDate?: string | null;
}

export interface Collector {
  agency: Agency;
  /** 기준일 이후 변경분. 실패는 CollectorError(사유 문구)로 던진다 → G0 */
  collect(since: SinceKv | null): Promise<SourceDelta[]>;
}

let override: Collector[] | null = null;

/** 테스트·운영 도구용 주입. null 이면 env 기반 기본 수집기로 돌아간다 */
export function setCollectors(c: Collector[] | null): void {
  override = c;
}

export function activeCollectors(): Collector[] {
  if (override) return override;
  return [
    lawCenterCollector({ oc: env.LAW_API_OC, baseUrl: env.LAW_API_BASE_URL }),
    ftcCollector({ oc: env.LAW_API_OC, baseUrl: env.LAW_API_BASE_URL }),
    dataPortalCollector({ serviceKey: env.DATA_PORTAL_KEY, url: env.DATA_PORTAL_STD_TERMS_URL }),
    kcaCollector({ apiKey: env.KCA_API_KEY, url: env.KCA_API_URL }),
  ];
}
