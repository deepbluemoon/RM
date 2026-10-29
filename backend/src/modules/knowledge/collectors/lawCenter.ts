// 국가법령정보센터 Open API(DRF) 수집기(T130, 0.1 `KMS -> LAW`). 범위 5개 법률 + 시행령·시행규칙.
// lawSearch.do(target=law)로 현행 법령 일련번호·시행일·공포일을 찾고, 기준일 이후 바뀐 법령만 lawService.do 로 조문을 받는다.
// 응답 필드 이름은 DRF JSON 기준([추정] — 운영 키로 확인 필요). 키(OC)는 env LAW_API_OC 로만 받는다
import type { Collector, SinceKv, SourceDelta } from './index.js';
import { after, asArray, getJson, requireKey, ymd, type FetchLike } from './http.js';

/** 근거 범위 법령(FR-021) — evidence_item.source_name 과 같은 정식 명칭 */
export const LAW_TARGETS = [
  '약관의 규제에 관한 법률',
  '약관의 규제에 관한 법률 시행령',
  '전자상거래 등에서의 소비자보호에 관한 법률',
  '전자상거래 등에서의 소비자보호에 관한 법률 시행령',
  '전자상거래 등에서의 소비자보호에 관한 법률 시행규칙',
  '소비자기본법',
  '소비자기본법 시행령',
  '할부거래에 관한 법률',
  '할부거래에 관한 법률 시행령',
  '방문판매 등에 관한 법률',
  '방문판매 등에 관한 법률 시행령',
];

interface LawSearchRow {
  법령명한글?: string;
  법령일련번호?: string | number;
  시행일자?: string | number;
  공포일자?: string | number;
  제개정구분명?: string;
}

interface HoRow {
  호번호?: string;
  호내용?: string | string[];
  목?: { 목내용?: string | string[] } | { 목내용?: string | string[] }[];
}

interface ArticleRow {
  조문번호?: string | number;
  조문가지번호?: string | number;
  조문여부?: string;
  조문시행일자?: string | number;
  조문변경여부?: string;
  조문내용?: string | string[];
  항?: { 항번호?: string; 항내용?: string | string[]; 호?: HoRow | HoRow[] } | { 항번호?: string; 항내용?: string | string[]; 호?: HoRow | HoRow[] }[];
}

const text = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join('\n') : v ?? '');

/** DRF 조문 단위 → 조문 전문(조 머리 + 항 + 호 + 목, 줄 단위) */
export function articleText(a: ArticleRow): string {
  const lines = [text(a.조문내용)];
  for (const p of asArray(a.항)) {
    lines.push(text(p.항내용));
    for (const h of asArray(p.호)) {
      lines.push(text(h.호내용));
      for (const m of asArray(h.목)) lines.push(text(m.목내용));
    }
  }
  return lines.filter((l) => l.trim()).join('\n');
}

export function lawCenterCollector(cfg: { oc: string; baseUrl?: string; fetchImpl?: FetchLike }): Collector {
  const base = (cfg.baseUrl || 'https://www.law.go.kr/DRF').replace(/\/$/, '');
  return {
    agency: 'law_center',
    async collect(since: SinceKv | null): Promise<SourceDelta[]> {
      const oc = requireKey(cfg.oc, 'LAW_API_OC');
      const out: SourceDelta[] = [];
      for (const name of LAW_TARGETS) {
        const q = `${base}/lawSearch.do?OC=${encodeURIComponent(oc)}&target=law&type=JSON&display=20&query=${encodeURIComponent(name)}`;
        const res = await getJson<{ LawSearch?: { law?: LawSearchRow | LawSearchRow[] } }>(q, { fetchImpl: cfg.fetchImpl });
        const law = asArray(res.LawSearch?.law).find((l) => (l.법령명한글 ?? '').replace(/\s+/g, '') === name.replace(/\s+/g, ''));
        if (!law?.법령일련번호) continue;
        const effective = ymd(law.시행일자);
        const published = ymd(law.공포일자);
        // 기준일 이후 공포·시행된 법령만 조문을 받는다(시행 전 공포분은 0.3 에서 보류)
        if (since && !after(effective, since.knowledgeDate) && !after(published, since.knowledgeDate)) continue;
        const detail = await getJson<{ 법령?: { 조문?: { 조문단위?: ArticleRow | ArticleRow[] } } }>(
          `${base}/lawService.do?OC=${encodeURIComponent(oc)}&target=law&type=JSON&MST=${encodeURIComponent(String(law.법령일련번호))}`,
          { fetchImpl: cfg.fetchImpl },
        );
        const url = `https://www.law.go.kr/법령/${name.replace(/\s+/g, '')}`;
        for (const a of asArray(detail.법령?.조문?.조문단위)) {
          if (a.조문여부 && a.조문여부 !== '조문') continue; // 장·절 제목(전문) 제외
          if (since && a.조문변경여부 && a.조문변경여부 !== 'Y') continue;
          const no = String(a.조문번호 ?? '').trim();
          if (!no) continue;
          const identifier = `제${no}조${a.조문가지번호 ? `의${a.조문가지번호}` : ''}`;
          const body = articleText(a);
          const repealed = /^\s*제\s*\d+\s*조(?:의\s*\d+)?\s*삭제/.test(body) || /^\s*삭제\s*[<[]/.test(body);
          out.push({
            agency: 'law_center',
            changeKind: repealed ? 'repeal' : since ? 'amend' : 'new_law',
            sourceType: 'law_article',
            sourceName: name,
            identifier,
            title: `${name} ${identifier}${repealed ? ' 삭제' : since ? ' 개정' : ''}`,
            rawText: body,
            sourceUrl: url,
            effectiveDate: ymd(a.조문시행일자) ?? effective,
            publishedDate: published,
          });
        }
      }
      return out;
    },
  };
}
