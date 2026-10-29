// 코드 사전과 한국어 표기(T019). DB CHECK 값(design/crd_ddl.sql)과 같은 값만 둔다.
export const CONTRACT_TYPES = ['ecommerce', 'subscription', 'installment', 'door_to_door', 'general_consumer', 'out_of_scope'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_TYPE_LABEL: Record<ContractType, string> = {
  ecommerce: '전자상거래',
  subscription: '구독',
  installment: '할부',
  door_to_door: '방문판매',
  general_consumer: '일반 소비자 거래',
  out_of_scope: '범위 밖',
};

export const RISK_CATEGORIES = ['normal', 'dispute', 'unfair', 'illegal'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export const DISPLAY_CATEGORIES = [...RISK_CATEGORIES, 'unanalyzable'] as const;
export type DisplayCategory = (typeof DISPLAY_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<DisplayCategory, string> = {
  normal: '정상',
  dispute: '분쟁 가능',
  unfair: '불공정 가능',
  illegal: '위법 가능',
  unanalyzable: '분석 불가',
};

export const RISK_TYPES = ['rights_limit', 'liability_avoid', 'refund_cancel_limit', 'unilateral_change', 'excessive_penalty', 'vague', 'other'] as const;
export type RiskType = (typeof RISK_TYPES)[number];
export const RISK_TYPE_LABEL: Record<RiskType, string> = {
  rights_limit: '권리 제한',
  liability_avoid: '책임 회피',
  refund_cancel_limit: '환불·해지 제한',
  unilateral_change: '일방적 변경',
  excessive_penalty: '과도한 위약금',
  vague: '모호한 표현',
  other: '기타',
};

export const RISK_LEVELS = ['high', 'mid', 'low'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LEVEL_LABEL: Record<RiskLevel, string> = { high: '높음', mid: '중간', low: '낮음' };

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const CONFIDENCE_LABEL: Record<Confidence, string> = { high: '높음', medium: '보통', low: '낮음' };

export const PII_TYPES = ['rrn', 'foreigner_no', 'account_no', 'card_no', 'phone', 'email', 'address', 'person_name'] as const;
export type PiiType = (typeof PII_TYPES)[number];
/** C8 가림 표기 〔유형〕 — 대괄호 [ ] 금지(SD_02 C8) */
export const PII_LABEL: Record<PiiType, string> = {
  rrn: '주민등록번호',
  foreigner_no: '외국인등록번호',
  account_no: '계좌번호',
  card_no: '카드번호',
  phone: '전화번호',
  email: '이메일',
  address: '주소',
  person_name: '이름',
};

export const PERSPECTIVES = ['consumer', 'business'] as const;
export type Perspective = (typeof PERSPECTIVES)[number];
export const PERSPECTIVE_LABEL: Record<Perspective, string> = { consumer: '소비자', business: '사업자' };

export const SOURCE_TYPES = ['law_article', 'ftc_case', 'std_terms'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = { law_article: '법령', ftc_case: '공정위 사례', std_terms: '표준약관' };

export const ROLES = ['user', 'operator', 'developer', 'legal_expert'] as const;
export type Role = (typeof ROLES)[number];

export const FILE_FORMATS = ['pdf', 'hwp', 'hwpx', 'docx', 'html'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const REQUEST_STAGES = ['received', 'deidentifying', 'structuring', 'awaiting_type', 'type_confirmed', 'stopped'] as const;
export type RequestStage = (typeof REQUEST_STAGES)[number];
export const RUN_STAGES = ['detecting', 'searching', 'explaining', 'completed', 'saved', 'aborted'] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const DISCLAIMER = '본 결과는 법률 자문이 아니며 위험 가능성 정보입니다';

export const LAW_NAMES = [
  '약관의 규제에 관한 법률',
  '전자상거래 등에서의 소비자보호에 관한 법률',
  '소비자기본법',
  '할부거래에 관한 법률',
  '방문판매 등에 관한 법률',
] as const;

export function codesDictionary() {
  return {
    contractTypes: CONTRACT_TYPE_LABEL,
    categories: CATEGORY_LABEL,
    riskTypes: RISK_TYPE_LABEL,
    riskLevels: RISK_LEVEL_LABEL,
    confidences: CONFIDENCE_LABEL,
    piiTypes: PII_LABEL,
    perspectives: PERSPECTIVE_LABEL,
    sourceTypes: SOURCE_TYPE_LABEL,
  };
}
