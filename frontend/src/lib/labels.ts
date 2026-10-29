// 코드 → 화면 표기(SD_02 §3-3, spec 용어 정의). 서버 `/meta/codes` 가 같은 사전을 내려주지만
// 첫 화면을 막지 않도록 앱 안에 기본값을 둔다.
import type {
  Confidence, ContractType, DisplayCategory, PiiType, Perspective, RiskLevel, RiskType,
} from '@/api/types'

export const CATEGORY: Record<DisplayCategory, string> = {
  normal: '정상',
  dispute: '분쟁 가능',
  unfair: '불공정 가능',
  illegal: '위법 가능',
  unanalyzable: '판단 어려움',
}
export const RISK_TYPE: Record<RiskType, string> = {
  rights_limit: '소비자 권리 제한',
  liability_avoid: '책임 회피',
  refund_cancel_limit: '환불·해지 제한',
  unilateral_change: '일방적 변경',
  excessive_penalty: '과도한 위약금',
  vague: '모호한 표현',
  other: '기타',
}
export const RISK_LEVEL: Record<RiskLevel, string> = { high: '높음', mid: '중간', low: '낮음' }
export const RISK_SYMBOL: Record<RiskLevel, string> = { high: '●', mid: '◐', low: '○' }
export const CONFIDENCE: Record<Confidence, string> = { high: '높음', medium: '보통', low: '낮음' }
export const CONTRACT_TYPE: Record<ContractType, string> = {
  ecommerce: '전자상거래',
  subscription: '구독',
  installment: '할부',
  door_to_door: '방문판매',
  general_consumer: '일반 소비자 거래',
  out_of_scope: '분석 대상 아님',
}
export const CONTRACT_TYPES = Object.keys(CONTRACT_TYPE) as ContractType[]
export const PERSPECTIVE: Record<Perspective, string> = { consumer: '소비자', business: '사업자' }
export const PII: Record<PiiType, string> = {
  rrn: '주민등록번호',
  foreigner_no: '외국인등록번호',
  account_no: '계좌번호',
  card_no: '카드번호',
  phone: '전화번호',
  email: '이메일',
  address: '주소',
  person_name: '이름',
}
export const PII_LABELS = Object.values(PII)
export const SOURCE_TYPE: Record<string, string> = { law_article: '법령', ftc_case: '공정위 사례', std_terms: '표준약관' }
export const CHANGE_KIND: Record<string, string> = {
  amend: '개정',
  repeal: '폐지',
  new_law: '새 법령',
  new_case: '새 사례',
  std_terms_revision: '표준약관 개정',
  reference: '참고',
}
export const AGENCY: Record<string, string> = {
  law_center: '국가법령정보센터',
  ftc: '공정거래위원회',
  data_portal: '공공데이터포털',
  kca: '한국소비자원',
}
export const DECISION_LABEL: Record<string, string> = {
  candidate: '근거 후보',
  hold_not_effective: '보류 - 아직 시행 전',
  excluded_repealed: '제외 - 폐지된 법령',
  excluded_parse_fail: '제외 - 조항을 나누지 못함(G1)',
  reference_only: '참고 자료',
}
export const FEEDBACK_TYPE: Record<string, string> = { false_positive: '위험하지 않은데 위험으로 표시됨', false_negative: '놓친 위험 조항' }
export const REVIEW_DECISION: Record<string, string> = { valid: '의견이 맞음', invalid: '의견이 맞지 않음', needs_expert: '전문가 확인 필요' }
export const ORIGIN: Record<string, string> = { new_label: '새로 정답을 붙인 문장', feedback_candidate: '이용자 의견에서 온 후보', synthetic: '일부러 바꿔 만든 문장' }
export const ROLE: Record<string, string> = { user: '사용자', operator: '운영자', developer: '개발자', legal_expert: '법률 전문가' }

export const SUB_STEP_LABEL: Record<string, string> = {
  received: '접수',
  deidentify: '개인정보 가리기',
  structure: '조항 나누기',
  detect: '위험 조항 찾기',
  search: '근거 찾기',
  explain: '설명 만들기',
}
export const SUB_STATE_LABEL: Record<string, string> = {
  waiting: '기다리는 중',
  running: '진행 중',
  done: '완료',
  blocked: '멈춤',
  reused: '이전 결과 사용',
}
export const MODEL_NAME: Record<string, string> = { M1: '회피형 탐지 모델', M2: '위법형 탐지 모델', M3: '최종 판단 모델', M4: '요약 모델' }
export const MODEL_LOAD_STATE: Record<string, string> = {
  ready: '준비됨(바로 응답)',
  loading: '메모리에 올리는 중',
  cold: '쉬는 중(첫 요청 때 준비)',
  missing: '설치 안 됨',
  error: '오류',
}
