// 이름 — (1) 역할 표지 뒤 2~4자 한글, (2) 서명란 "홍길동 (인)", (3) 존칭 "홍길동 님", (4) 파일명 속 이름,
// (5) 한 번 확정된 이름은 문서 전체에서 치환(deid.service). T108 보강: 갑/을 표지 변형·서명란 변형·오탐 억제
import type { PiiHit } from './types.js';

// 여러 글자 역할 표지. 글자 사이 공백 표기("성 명")도 받는다
const ROLE_MULTI =
  '성\\s?명|이\\s?름|성함|대표자|대표이사|대표|임대인|임차인|매도인|매수인|양도인|양수인|채권자|채무자|연대보증인|보증인|신청인명|신청인|계약자명|계약자|계약당사자|당사자|가입자명|가입자|예금주명|예금주|수신인|발신인|수령인|수취인|명의자|담당자|작성자|서명자|서명|고객명|회원명|본인|보호자|법정대리인|소유자|세입자';
// 한 글자 표지(갑·을·병)는 흔한 조사와 같은 글자라 괄호로 감싸거나 콜론·줄표가 붙을 때만 표지로 본다
const ROLE_ONE = '갑|을|병|甲|乙|丙';
const OPEN = '(?:^|[\\s(\\[<:：,「『"\'“‘（])';
const CLOSE = '[)\\]>」』"\'”’）]?';
/** 역할 뒤 괄호 설명 — "을(회원)", "성명(한글)", "임차인(을)" */
const PAREN = '(?:\\s*[(（][가-힣A-Za-z ]{1,10}[)）])?';
const NAME = '([가-힣]{2,4})';
// 콜론 뒤 이름의 경계(조사 포함)
const TAIL_ALT = '\\s|$|[,.)\\]〕:：;·/]|\\(|님|씨|은|는|이|가|을|를|의|에게|과|와|\\d';
const TAIL = `(?=${TAIL_ALT})`;
// 공백만으로 이어진 이름은 뒤가 줄 끝·쉼표·괄호·존칭일 때만 — "보증인 또는 임차인" 같은 본문 오탐 방지
const STRONG_TAIL = '(?=[ \\t]*(?:$|[,，(（/·]|[)\\]」』）])|[ \\t]?(?:님|씨|귀하))';

const COLON_RE = new RegExp(`${OPEN}(?:${ROLE_MULTI}|${ROLE_ONE})${CLOSE}${PAREN}\\s*[:：\\-―–—]\\s*(?:[(（]\\s*)?${NAME}${TAIL}`, 'gm');
const SPACE_RE = new RegExp(`${OPEN}(?:${ROLE_MULTI})${CLOSE}${PAREN}[ \\t]+${NAME}${STRONG_TAIL}`, 'gm');
const BRACKET_ONE_RE = new RegExp(`[(\\[「『"'“‘（](?:${ROLE_ONE})[)\\]」』"'”’）]${PAREN}[ \\t]*${NAME}${STRONG_TAIL}`, 'gm');
const SIGN_RE = new RegExp(`(?<![가-힣])${NAME}[ \\t]*(?:[(（][ \\t]*(?:인|서명|印|날인|사인|싸인)[ \\t]*[)）]|㊞|印)`, 'g');
// 서술형 "제 이름은 홍길동입니다"(피드백 의견 등) — 이름·성명·성함 + 은/는/이 뒤
const LABEL_IS_RE = new RegExp(`(?:^|[\\s(\\[,])(?:성\\s?명|이\\s?름|성함)\\s*(?:은|는|이)\\s+${NAME}(?=\\s?(?:입니다|이고|이며|이다|이에요|예요|이요|님|씨)|[ \\t]*(?:[,.)]|$))`, 'gm');
const HONORIFIC_RE = new RegExp(`(?:^|[\\s(,])${NAME}\\s?(?:님|씨)(?=\\s|$|[,.)은는이가을를의께에])`, 'gm');

/** 이름으로 볼 수 없는 흔한 낱말 — 역할 표지 뒤에 와도 가리지 않는다 */
export const NOT_NAMES = new Set([
  '회사', '고객', '회원', '본인', '당사', '이용자', '사업자', '소비자', '계약', '상대방', '대리인', '법인', '주식회사', '갑과', '을과',
  '갑은', '을은', '이하', '모든', '해당', '각각', '상호', '다음', '아래', '위의', '전부', '일부', '제공', '서비스', '약관', '본계약',
  '임대인', '임차인', '매도인', '매수인', '보증인', '채권자', '채무자', '공급자', '수요자', '판매자', '구매자', '가맹점', '가맹본부',
  '대표', '대표자', '대표이사', '이사', '직원', '담당', '담당자', '관리자', '운영자', '신청인', '계약자', '가입자', '예금주', '성명',
  '이름', '서명', '날인', '인감', '주소', '연락처', '전화', '생년월일', '확인', '동의', '미기재', '기재', '없음', '해지', '환불',
  '위약금', '손해', '배상', '책임', '의무', '권리', '기간', '금액', '요금', '이용료', '수수료', '통지', '변경', '갱신', '관할', '법원',
  '분쟁', '조정', '신고', '고지', '안내', '공지', '회원님', '고객님', '귀하', '당신', '누구', '아무', '그는', '그녀', '우리', '저희',
  '홈페이지', '앱', '모바일', '온라인', '오프라인', '결제', '카드', '현금', '계약서', '계좌', '은행', '보험', '보험료', '할부', '구독', '정기',
  '또는', '및', '간의', '간에', '사이', '쌍방', '일방', '각자', '전원', '모두', '명의', '측', '번호', '이상', '이내', '이후', '이전',
  '사항', '내용', '조건', '규정', '기준', '방법', '절차', '목적', '정의', '효력', '시행', '부칙', '별지', '첨부', '서식', '양식',
  // 존칭 앞에 오는 직함("선생님"·"사장님")
  '선생', '사장', '부장', '과장', '차장', '대리', '팀장', '실장', '원장', '회장', '교수', '박사', '기사', '여러분', '담당자님',
]);

const JOSA_END = /[은는이가을를의에와과도로]$/;

export function isNameCandidate(s: string): boolean {
  if (NOT_NAMES.has(s)) return false;
  if (s.length < 2 || s.length > 4) return false;
  // "회사와"·"본인의"처럼 흔한 낱말 + 조사는 이름이 아니다
  if (s.length >= 3 && JOSA_END.test(s) && NOT_NAMES.has(s.slice(0, -1))) return false;
  return true;
}

// 파일명 속 이름(A14) — 확장자가 붙은 한 줄(파일명)에서만, 구분자로 나뉜 3자 한글 토큰 중 흔한 성씨로 시작하는 것.
// 본문에서 확정된 이름은 deid.service 가 따로 치환하므로 여기서는 본문 없이 파일명만 있을 때(접수 직후)를 막는다
const FILE_NAME_RE = /^[^\n]{1,255}\.(?:pdf|hwpx?|docx?|html?|txt)$/i;
const SURNAMES = new Set(
  '김이박최정강조윤장임한오서신권황안송류유전홍고문양손배백허남심노하곽성차주우구민나진지엄채원천방공현함변염여추도소석선설마길연위표명기반왕금옥육인맹제모탁국어은편용예경봉'.split(''),
);
const FILE_WORD_STOP = new Set([
  '이용권', '이용료', '임대차', '임대인', '임차인', '전세금', '최종본', '수정본', '신청서', '동의서', '확인서', '서약서', '안내문',
  '안내서', '한글판', '한국어', '주식회', '장기간', '정기권', '구독료', '위임장', '위탁서', '우편물', '홍보물', '유의점', '조건부',
  '표준안', '원본본', '고용주', '공사비', '방문판', '도급서', '신규본', '전자본', '정정본', '검토본', '초안본', '최신본', '변경안',
  '개정안', '개정본', '주택용', '상가용', '오피스', '서비스', '회원용', '고객용', '가입서', '이용안', '계약서', '계약용', '약관본',
]);

function detectFileNameNames(text: string): PiiHit[] {
  if (!FILE_NAME_RE.test(text)) return [];
  const out: PiiHit[] = [];
  const re = /[가-힣]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tok = m[0];
    const before = text[m.index - 1];
    const after = text[m.index + tok.length];
    // 앞뒤가 구분자(또는 시작·확장자 점)일 때만 한 토큰으로 본다
    const sepB = before === undefined || /[\s_\-()[\]{}.,·]/.test(before);
    const sepA = after === undefined || /[\s_\-()[\]{}.,·]/.test(after);
    if (!sepB || !sepA || tok.length !== 3) continue;
    if (!SURNAMES.has(tok[0]!) || FILE_WORD_STOP.has(tok) || !isNameCandidate(tok)) continue;
    out.push({ type: 'person_name', start: m.index, end: m.index + tok.length });
  }
  return out;
}

export function detectNameMarkers(text: string): PiiHit[] {
  const out: PiiHit[] = [];
  for (const re of [COLON_RE, SPACE_RE, BRACKET_ONE_RE, LABEL_IS_RE, SIGN_RE, HONORIFIC_RE]) {
    const g = new RegExp(re.source, re.flags.replace('d', '') + 'd');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      const name = m[1]!;
      const idx = m.indices?.[1];
      // 겹치는 표지("임차인 성명: 홍길동")도 다시 보도록 한 글자씩만 전진한다
      g.lastIndex = m.index + 1;
      if (!idx || !isNameCandidate(name)) continue;
      out.push({ type: 'person_name', start: idx[0], end: idx[1] });
    }
  }
  out.push(...detectFileNameNames(text));
  return out;
}

/** 확정된 이름 문자열을 문서 전체에서 찾는다(A14 — 표시명 포함) */
export function detectKnownNames(text: string, names: Set<string>): PiiHit[] {
  const out: PiiHit[] = [];
  for (const name of names) {
    let i = text.indexOf(name);
    while (i !== -1) {
      out.push({ type: 'person_name', start: i, end: i + name.length });
      i = text.indexOf(name, i + name.length);
    }
  }
  return out;
}
