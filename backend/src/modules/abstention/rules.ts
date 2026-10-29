// 판정 불가 관문 1 — 규칙 기반 입력 검사(2026-09-30, 추가 비용 0). 조항 1건을 보고 모델을 부르기 전에 거른다.
// 사유: invalid_input(읽을 수 없는 입력) · not_clause(계약 조항이 아님) · prompt_injection(모델에 대한 지시문)
// 기준값은 정상 조항(실제 약관 2,752 조항)을 잘못 막는 비율 1% 이하가 되도록 scripts/calibrate-abstention.ts 로 확인한다.
export type AbstentionReason = 'invalid_input' | 'not_clause' | 'prompt_injection';

export interface RuleVerdict {
  reason: AbstentionReason;
  code: string;          // 세부 사유(화면·기록용)
  detail: string;
}

/** 모델(M3)에 대한 지시·역할 변경 시도. 계약 문장에는 나오지 않는 표현만 쓴다 */
const INJECTION = [
  /(이전|위의?|앞의?|기존)\s*(모든\s*)?(지시|명령|지침|규칙|프롬프트)(을|를)?\s*(무시|잊|따르지)/,
  /시스템\s*프롬프트|system\s*prompt|developer\s*message/i,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+(instructions|prompts?)/i,
  /(너는|당신은)\s*이제|you\s+are\s+now|act\s+as\s+(a|an)\b/i,
  /(위법|불공정|정상)(이\s*아니라고|이라고)\s*(답|판정|출력)/,
  /(risk_class|evidence_ids|json)\s*(을|를|은|는)?\s*(다음과\s*같이|이렇게)?\s*(출력|반환|답)/i,
];

const HEADER = /^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:[(\[【<][^)\]】>]{0,40}[)\]】>])?\s*/;
const MARKER_ONLY = /^[\s/·.,:;\-]*(?:[(<]?\s*(?:삭제|신설|좌동|생략|이하\s*생략|전략|중략|후략)\s*[)>]?[\s/·.,:;\-]*)*$/;

export function ruleCheck(raw: string): RuleVerdict | null {
  const text = (raw ?? '').replace(/ /g, ' ');
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 6) return { reason: 'invalid_input', code: 'too_short', detail: '내용이 너무 짧습니다' };

  for (const re of INJECTION) {
    if (re.test(text)) return { reason: 'prompt_injection', code: 'injection', detail: '모델에 대한 지시문으로 보이는 문장이 있습니다' };
  }

  // 조 머리·편집 표시만 있고 본문이 없는 조항
  const body = text.replace(HEADER, '');
  if (MARKER_ONLY.test(body) || body.replace(/\s+/g, '').length < 4) {
    return { reason: 'not_clause', code: 'header_only', detail: '조 제목만 있고 조항 본문이 없습니다' };
  }

  // 문자 구성: 한글 음절·영문·숫자·흔한 문장부호 외 문자가 많으면 깨진 입력(OCR 오류·인코딩 깨짐)
  const chars = [...compact];
  const hangul = chars.filter((c) => /[가-힣]/.test(c)).length;
  const jamo = chars.filter((c) => /[ㄱ-ㅎㅏ-ㅣ]/.test(c)).length;
  const latin = chars.filter((c) => /[A-Za-z]/.test(c)).length;
  const digit = chars.filter((c) => /[0-9０-９]/.test(c)).length;
  // 흔한 문장부호·글머리 기호(•▪►★→ 등)는 정상 문자로 센다 — 다른 형식의 약관이 잘못 막히지 않게
  const punct = chars.filter((c) => /[.,·:;'"“”‘’()\[\]{}<>「」『』《》〈〉【】\-–—~/%&+=?!①-⑳⑴-⒇㉠-㉭㈜※○●□■▶▷◇◆◎◉ㆍ…`@#*_|\\^$•▪▫►▲△▼▽★☆→←↑↓⇒※·‖│─━┃┌┐└┘├┤┬┴┼×÷±≤≥≠≒∼≈∙￦₩℃㎡㎏㎝㎜㎞]/.test(c)).length;  // 계산식·단위 기호 포함
  const other = chars.length - hangul - jamo - latin - digit - punct;
  const n = chars.length;
  // 기준 6%: 정상 약관 조항 2,752개의 최댓값 2.45%(보정 2026-09-30), 가벼운 OCR 오류(20% 훼손) 40/40 검출
  if (other / n > 0.06) return { reason: 'invalid_input', code: 'garbled', detail: '알아볼 수 없는 문자가 많습니다(인식 오류 가능)' };
  if (jamo / n > 0.1) return { reason: 'invalid_input', code: 'garbled', detail: '완성되지 않은 글자(자음·모음)가 많습니다' };
  // 같은 글자(한글·영문·숫자) 8번 이상 반복. 줄임표·점선·밑줄 같은 채움 기호(……, ----, ____)는 서식이라 제외(다른 업종 약관 점검 2026-09-30)
  if (/([가-힣A-Za-z0-9ㄱ-ㅎㅏ-ㅣ])\1{7,}/.test(compact)) return { reason: 'invalid_input', code: 'repeated', detail: '같은 글자가 반복됩니다' };
  if ((digit + punct) / n > 0.6) return { reason: 'invalid_input', code: 'symbols', detail: '숫자·기호만 있고 문장이 없습니다' };
  // 한국어 소비자 약관이 대상 — 한글이 거의 없는 긴 글(영문 계약·코드)은 범위 밖
  if (n >= 30 && hangul / Math.max(1, hangul + latin) < 0.2) {
    return { reason: 'not_clause', code: 'not_korean', detail: '한국어 계약 조항이 아닙니다' };
  }
  return null;
}
