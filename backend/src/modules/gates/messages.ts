// 게이트 문구 사전(T021) — SD_02 §14-2 를 옮겼다. 같은 게이트는 어느 화면에서든 같은 제목·사유를 쓴다(규칙 ④).
// title 은 design/crd_ddl.sql gate_def.title_text 와 같아야 한다(T043). 〈〉 값이 들어가는 제목은 titleTemplate 로 만든다.
export type GateCode = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'G10' | 'G11' | 'G12' | 'G13' | 'G14';
export type ReleaseActor = 'user' | 'operator' | 'legal_expert' | 'system' | 'operator_expert';

export interface NextAction {
  id: string;
  label: string;
}

export interface GateMessage {
  title: string;
  titleTemplate?: string;
  reasonTemplate: string;
  releaseActor: ReleaseActor;
  releaseText: string;
  scope: 'full' | 'partial';
  nextActions: NextAction[];
}

export const GATE_MESSAGES: Record<GateCode, GateMessage> = {
  G0: {
    title: '외부 자료를 모두 받지 못했습니다',
    reasonTemplate: '{agency}에서 변경분을 받지 못해 새 지식 기준일을 만들 수 없습니다. 현재 기준일을 유지합니다',
    releaseActor: 'operator',
    releaseText: '운영자 - 다시 수집',
    scope: 'full',
    nextActions: [{ id: 'retry_collect', label: '다시 수집' }],
  },
  G1: {
    title: '구조 분리 실패 - 이번 반영에서 제외됩니다',
    titleTemplate: '구조 분리 실패 {n}건 - 이번 반영에서 제외됩니다',
    reasonTemplate: '{item}을 조·항·호 또는 사실관계·판단·근거로 나누지 못했습니다',
    releaseActor: 'operator',
    releaseText: '운영자 - 검토 목록에서 정정 후 다음 갱신에 다시 반영',
    scope: 'partial',
    nextActions: [{ id: 'open_review_list', label: '검토 목록 열기' }],
  },
  G2: {
    title: '파일 조건을 충족하지 않습니다',
    reasonTemplate: '{detail}',
    releaseActor: 'user',
    releaseText: '사용자 - 조건에 맞는 파일 또는 텍스트로 다시 입력',
    scope: 'full',
    nextActions: [
      { id: 'choose_other_file', label: '다른 파일 선택' },
      { id: 'switch_to_text', label: '텍스트 붙여넣기로 전환' },
    ],
  },
  G3: {
    title: 'URL 본문을 가져올 수 없습니다',
    reasonTemplate: '{detail}',
    releaseActor: 'user',
    releaseText: '사용자 - 파일 업로드 또는 텍스트 붙여넣기로 전환',
    scope: 'full',
    nextActions: [
      { id: 'switch_to_file', label: '파일 업로드로 전환' },
      { id: 'switch_to_text', label: '텍스트 붙여넣기로 전환' },
    ],
  },
  G4: {
    title: '이번 달 무료 분석을 모두 사용했습니다',
    reasonTemplate: '무료 분석 {limit}건을 모두 사용했습니다. 기존 결과는 그대로 볼 수 있습니다',
    releaseActor: 'system',
    releaseText: '시스템 - {resetMd} 초기화',
    scope: 'full',
    nextActions: [],
  },
  G5: {
    title: '분석 일시 불가',
    reasonTemplate: '분석 서버가 {state}입니다. 서버가 복구되면 다시 시도해 주세요',
    releaseActor: 'operator',
    releaseText: '운영자 - 서버 복구',
    scope: 'full',
    nextActions: [{ id: 'recheck_status', label: '상태 다시 확인' }],
  },
  G6: {
    title: '계약서·약관으로 인식되지 않았습니다',
    reasonTemplate: '입력한 문서에서 계약 조항 구조를 찾지 못했습니다',
    releaseActor: 'user',
    releaseText: '사용자 - 계약서·약관 문서로 다시 입력',
    scope: 'full',
    nextActions: [{ id: 'restart_input', label: '다른 문서로 다시 입력' }],
  },
  G7: {
    title: '결과 제공 보류',
    reasonTemplate: '같은 조항이 관점에 따라 다르게 판정되어 결과를 보류합니다. 운영자 점검 대상으로 기록되었습니다',
    releaseActor: 'operator',
    releaseText: '운영자 - 점검 후 처리',
    scope: 'full',
    nextActions: [],
  },
  G8: {
    title: '접근할 수 없습니다',
    titleTemplate: '{what} 수 없습니다',
    reasonTemplate: '{detail}',
    releaseActor: 'user',
    releaseText: '사용자 - {how}',
    scope: 'full',
    nextActions: [
      { id: 'login', label: '로그인' },
      { id: 'new_analysis', label: '새 분석 시작' },
    ],
  },
  G9: {
    title: '설명 제공 불가',
    reasonTemplate: '쉬운 설명이 표현 검사를 통과하지 못해 표시하지 않습니다. 판정과 근거는 그대로 제공됩니다',
    releaseActor: 'system',
    releaseText: '시스템 - 재생성 1회 실패, 모델 개선 후 해소',
    scope: 'partial',
    nextActions: [{ id: 'open_evidence', label: '근거 목록 보기' }],
  },
  G10: {
    title: '평가에서 제외된 조항',
    titleTemplate: '평가에서 제외된 조항 {n}건',
    reasonTemplate: '{detail} 조항은 평가에 쓸 수 없습니다',
    releaseActor: 'legal_expert',
    releaseText: '법률 전문가 - 검수 완료 (인위적 변형·학습 중복은 해제 불가)',
    scope: 'partial',
    nextActions: [{ id: 'request_review', label: '검수 요청 보내기' }],
  },
  G11: {
    title: '근거 적합률 판정 대기',
    reasonTemplate: '근거 적합성 전문가 판정이 {done} / {total}건만 회신되었습니다',
    releaseActor: 'legal_expert',
    releaseText: '법률 전문가 - 판정 회신',
    scope: 'partial',
    nextActions: [{ id: 'request_expert', label: '판정 의뢰 보내기' }],
  },
  G12: {
    title: '측정 불가',
    titleTemplate: '{contractType} 측정 불가',
    reasonTemplate: '{contractType} 평가 조항이 부족합니다',
    releaseActor: 'operator_expert',
    releaseText: '운영자·법률 전문가 - 평가 데이터 보강',
    scope: 'partial',
    nextActions: [{ id: 'register_eval_items', label: '평가 데이터 등록' }],
  },
  G13: {
    title: '비식별화되지 않은 개인정보가 발견되었습니다',
    reasonTemplate: '{field}에서 가려지지 않은 {types}이 발견되어 표시를 막고 가리는 중입니다. 보안 사고로 기록했습니다',
    releaseActor: 'system',
    releaseText: '시스템 - 가림 처리 후 표시 재개 / 원인 조치는 운영자',
    scope: 'partial',
    nextActions: [],
  },
  G14: {
    title: '접근 권한이 없습니다',
    reasonTemplate: '운영자·개발자 권한이 필요한 메뉴입니다',
    releaseActor: 'operator',
    releaseText: '운영자 - 권한 부여',
    scope: 'full',
    nextActions: [],
  },
};

/** 게이트가 아닌 안내 문구(C2 가 아니라 세부 줄·확인 대화상자에 쓴다) */
export const NOTICES = {
  notCharged: '한도가 차감되지 않았습니다',
  cancelConfirm: '취소하면 이번 달 무료 분석 1건이 차감됩니다',
  cancelDone: '분석을 취소했습니다. 이번 달 무료 분석 1건이 차감되었습니다',
  feedbackReceived: '판정은 바로 바뀌지 않으며 운영자가 검토합니다',
  anonRetention: '이 결과는 이 브라우저에서 마지막으로 연 뒤 24시간 동안만 볼 수 있습니다. 보관하려면 로그인하세요',
  deleteConfirm: '문서와 분석 결과가 영구 삭제되며 되돌릴 수 없습니다. 이 결과에 남긴 피드백은 누구의 것인지 알 수 없는 형태로만 남습니다',
  coldStart: '모델을 메모리에 올리는 중입니다. 처음 한 번은 준비 시간이 더 걸립니다',
  queue: '공유 모델 서버에서 앞선 요청을 기다리는 중입니다',
} as const;

export function fill(template: string, params: Record<string, string | number | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] === undefined ? '' : String(params[k])));
}
