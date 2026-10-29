// SD_02 §14-2 게이트 문구 사전. 서버 GateError 가 우선이며, 이 사전은
// (1) 200 응답 안의 openGates(제목·사유만 옴)를 C2 로 보일 때 빈 칸을 채우고
// (2) 요청 전에 화면이 먼저 아는 게이트(C11 연결 불가 G5)의 C3 사유에 쓴다.
// 로컬 사업자 검증 모드에서는 G4(이용 한도)가 발생하지 않는다. G14 = RBAC 권한 부족(modules/auth/rbac.ts) — 사전 항목은 SD_02 §14-2 대조용.
import type { GateErrorBody, OpenGate } from '@/api/types'

export type ReleaseActor = GateErrorBody['releaseActor']

export interface GateView {
  gate: string
  title: string
  reason: string
  releaseActor: ReleaseActor | string
  releaseText?: string
  nextActions: { id: string; label: string }[]
  scope?: 'full' | 'partial'
  detail?: Record<string, unknown>
}

interface Entry { title: string; reason: string; actor: ReleaseActor; release: string; actions?: { id: string; label: string }[] }

export const GATE_DICT: Record<string, Entry> = {
  G0: { title: '외부 자료를 모두 받지 못했습니다', reason: '일부 기관에서 변경분을 받지 못해 새 지식 기준일을 만들 수 없습니다. 현재 기준일을 유지합니다', actor: 'operator', release: '운영자 - 다시 수집', actions: [{ id: 'retry_collect', label: '다시 수집' }] },
  G1: { title: '구조 분리 실패 항목 - 이번 반영에서 제외됩니다', reason: '항목을 조·항·호 또는 사실관계·판단·근거로 나누지 못했습니다', actor: 'operator', release: '운영자 - 검토 목록에서 정정 후 다음 갱신에 다시 반영', actions: [{ id: 'open_review_list', label: '검토 목록 열기' }] },
  G2: { title: '파일 조건을 충족하지 않습니다', reason: '50MB·300쪽 한도 초과, 암호화, 손상 또는 지원하지 않는 형식입니다', actor: 'user', release: '사용자 - 조건에 맞는 파일 또는 텍스트로 다시 입력', actions: [{ id: 'choose_other_file', label: '다른 파일 선택' }, { id: 'switch_to_text', label: '텍스트 붙여넣기로 전환' }] },
  G3: { title: 'URL 본문을 가져올 수 없습니다', reason: '로그인이 필요한 페이지이거나 접근이 차단되었거나 본문이 없습니다', actor: 'user', release: '사용자 - 파일 업로드 또는 텍스트 붙여넣기로 전환', actions: [{ id: 'switch_to_file', label: '파일 업로드로 전환' }, { id: 'switch_to_text', label: '텍스트 붙여넣기로 전환' }] },
  G4: { title: '이번 달 무료 분석을 모두 사용했습니다', reason: '무료 분석 3건을 모두 사용했습니다. 기존 결과는 그대로 볼 수 있습니다', actor: 'system', release: '시스템 - 월 초기화' },
  G5: { title: '분석 일시 불가', reason: '분석 서버가 응답하지 않습니다. 서버가 복구되면 다시 시도해 주세요', actor: 'operator', release: '운영자 - 서버 복구', actions: [{ id: 'recheck_status', label: '상태 다시 확인' }] },
  G6: { title: '계약서·약관으로 인식되지 않았습니다', reason: '입력한 문서에서 계약 조항 구조를 찾지 못했습니다', actor: 'user', release: '사용자 - 계약서·약관 문서로 다시 입력', actions: [{ id: 'reinput', label: '다른 문서로 다시 입력' }] },
  G7: { title: '결과 제공 보류', reason: '같은 조항이 관점에 따라 다르게 판정되어 결과를 보류합니다. 운영자 점검 대상으로 기록되었습니다', actor: 'operator', release: '운영자 - 점검 후 처리' },
  G8: { title: '결과를 볼 수 없습니다', reason: '다른 계정으로 만든 기록이거나 삭제된 기록입니다', actor: 'user', release: '사용자 - 기록을 만든 계정으로 로그인 또는 새 분석', actions: [{ id: 'new_analysis', label: '새 분석 시작' }] },
  G9: { title: '설명 제공 불가', reason: '쉬운 설명이 표현 검사를 통과하지 못해 표시하지 않습니다. 판정과 근거는 그대로 제공됩니다', actor: 'system', release: '시스템 - 재생성 1회 실패, 모델 개선 후 해소', actions: [{ id: 'show_evidence', label: '근거 목록 보기' }] },
  G10: { title: '평가에서 제외된 조항', reason: '검수 미완료·인위적 변형·학습 데이터 중복 조항은 평가에 쓸 수 없습니다', actor: 'legal_expert', release: '법률 전문가 - 검수 완료 (인위적 변형·학습 중복은 해제 불가)', actions: [{ id: 'request_review', label: '검수 요청 보내기' }] },
  G11: { title: '근거 적합률 판정 대기', reason: '근거 적합성 전문가 판정이 일부만 회신되었습니다', actor: 'legal_expert', release: '법률 전문가 - 판정 회신', actions: [{ id: 'request_verdict', label: '판정 의뢰 보내기' }] },
  G12: { title: '측정 불가', reason: '평가 조항이 부족합니다', actor: 'operator_expert', release: '운영자·법률 전문가 - 평가 데이터 보강', actions: [{ id: 'register_eval_data', label: '평가 데이터 등록' }] },
  G13: { title: '비식별화되지 않은 개인정보가 발견되었습니다', reason: '가려지지 않은 개인정보가 발견되어 표시를 막고 가리는 중입니다. 보안 사고로 기록했습니다', actor: 'system', release: '시스템 - 가림 처리 후 표시 재개 / 원인 조치는 운영자' },
  G14: { title: '접근 권한이 없습니다', reason: '운영자·개발자 권한이 필요한 메뉴입니다', actor: 'operator', release: '운영자 - 권한 부여' },
}

export const ACTOR_LABEL: Record<string, string> = {
  user: '사용자',
  operator: '운영자',
  legal_expert: '법률 전문가',
  system: '시스템',
  operator_expert: '운영자·법률 전문가',
}

/** GateError / OpenGate / 게이트 코드 → C2 가 그리는 완전한 모양 */
export function toGateView(
  g: (Partial<GateErrorBody> & { gate: string }) | (OpenGate & { nextActions?: { id: string; label: string }[]; releaseText?: string }),
  overrides: Partial<GateView> = {},
): GateView {
  const d = GATE_DICT[g.gate]
  const src = g as Partial<GateErrorBody> & { scope?: 'full' | 'partial' }
  return {
    gate: g.gate,
    title: src.title ?? d?.title ?? g.gate,
    reason: src.reason ?? d?.reason ?? '',
    releaseActor: (src.releaseActor as string | undefined) ?? d?.actor ?? 'system',
    releaseText: src.releaseText ?? d?.release,
    nextActions: src.nextActions && src.nextActions.length ? src.nextActions : d?.actions ?? [],
    scope: src.scope,
    detail: src.detail as Record<string, unknown> | undefined,
    ...overrides,
  }
}

export function gateFromCode(code: string, overrides: Partial<GateView> = {}): GateView {
  return toGateView({ gate: code }, overrides)
}
