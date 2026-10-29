// 공정거래위원회 의결·시정 사례 수집기(T130, 0.1 `KMS -> PUB`). 공정위 결정문은 국가법령정보 공동활용 DRF(target=ftc)로 받는다
// (키 = LAW_API_OC 공용). 사례 3구분(사실관계·판단·근거)은 결정문 항목이 있으면 그대로, 없으면 0.2 전처리가 본문에서 나눈다.
// 응답 필드 이름은 [추정] — 운영 키로 확인 필요
import type { Collector, SinceKv, SourceDelta } from './index.js';
import { after, asArray, getJson, requireKey, ymd, type FetchLike } from './http.js';

/** 약관·소비자 거래 관련 결정문 검색어 */
export const FTC_QUERIES = ['약관', '전자상거래', '할부거래', '방문판매'];

interface FtcRow {
  결정문일련번호?: string | number;
  사건명?: string;
  사건번호?: string;
  의결일자?: string | number;
}

const pick = (o: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length) return v.join('\n');
  }
  return null;
};

export function ftcCollector(cfg: { oc: string; baseUrl?: string; fetchImpl?: FetchLike }): Collector {
  const base = (cfg.baseUrl || 'https://www.law.go.kr/DRF').replace(/\/$/, '');
  return {
    agency: 'ftc',
    async collect(since: SinceKv | null): Promise<SourceDelta[]> {
      const oc = requireKey(cfg.oc, 'LAW_API_OC');
      const seen = new Set<string>();
      const out: SourceDelta[] = [];
      for (const query of FTC_QUERIES) {
        const res = await getJson<{ Ftc?: { ftc?: FtcRow | FtcRow[] } }>(
          `${base}/lawSearch.do?OC=${encodeURIComponent(oc)}&target=ftc&type=JSON&display=100&sort=ddes&query=${encodeURIComponent(query)}`,
          { fetchImpl: cfg.fetchImpl },
        );
        for (const row of asArray(res.Ftc?.ftc)) {
          const id = String(row.결정문일련번호 ?? '');
          const decided = ymd(row.의결일자);
          if (!id || seen.has(id) || !after(decided, since?.knowledgeDate)) continue;
          seen.add(id);
          const d = await getJson<Record<string, Record<string, unknown>>>(
            `${base}/lawService.do?OC=${encodeURIComponent(oc)}&target=ftc&type=JSON&ID=${encodeURIComponent(id)}`,
            { fetchImpl: cfg.fetchImpl },
          );
          const body = (Object.values(d)[0] ?? {}) as Record<string, unknown>;
          const facts = pick(body, ['사실관계', '인정사실', '사건개요']);
          const judgment = pick(body, ['판단', '위법성판단', '이유']);
          const basis = pick(body, ['법령의적용', '관련법령', '근거법령', '근거']);
          const all = Object.values(body).filter((v): v is string => typeof v === 'string').join('\n');
          const caseNo = row.사건번호 ?? id;
          out.push({
            agency: 'ftc',
            changeKind: 'new_case',
            sourceType: 'ftc_case',
            sourceName: row.사건명 ?? caseNo,
            identifier: `${caseNo}${decided ? ` (${decided})` : ''}`,
            title: `${caseNo} ${row.사건명 ?? ''}`.trim(),
            rawText: all,
            caseSections: facts || judgment || basis ? { facts, judgment, basis } : null,
            sourceUrl: `https://www.law.go.kr/LSW/ftcInfoP.do?ftcSeq=${encodeURIComponent(id)}`,
            publishedDate: decided,
          });
        }
      }
      return out;
    },
  };
}
