// 한국소비자원 참고 자료 수집기(T130, 0.1). 소비자 분쟁 참고 자료는 근거 유형이 아니다(FR-021) — change_kind 'reference' 로만 남기고
// 근거로 반영하지 않는다(chk_ii_reference). 키 = KCA_API_KEY, 주소 = KCA_API_URL(활용 신청 후 받은 주소 — 기본값 없음). 필드 이름은 [추정]
import type { Collector, SinceKv, SourceDelta } from './index.js';
import { CollectorError, after, asArray, getJson, requireKey, ymd, type FetchLike } from './http.js';

interface KcaRow {
  title?: string;
  caseNo?: string;
  regDate?: string;
  summary?: string;
  url?: string;
}

export function kcaCollector(cfg: { apiKey: string; url?: string; fetchImpl?: FetchLike }): Collector {
  return {
    agency: 'kca',
    async collect(since: SinceKv | null): Promise<SourceDelta[]> {
      const key = requireKey(cfg.apiKey, 'KCA_API_KEY');
      if (!cfg.url) throw new CollectorError('주소 미설정 - KCA_API_URL');
      const sep = cfg.url.includes('?') ? '&' : '?';
      const res = await getJson<{ response?: { body?: { items?: { item?: KcaRow | KcaRow[] } } }; items?: KcaRow[] }>(
        `${cfg.url}${sep}serviceKey=${encodeURIComponent(key)}&numOfRows=100&type=json`,
        { fetchImpl: cfg.fetchImpl },
      );
      const rows = res.items ?? asArray(res.response?.body?.items?.item);
      return rows
        .filter((r) => r.title && after(ymd(r.regDate), since?.knowledgeDate))
        .map((r) => ({
          agency: 'kca' as const,
          changeKind: 'reference' as const,
          sourceType: null,
          sourceName: '한국소비자원 분쟁 참고 자료',
          identifier: r.caseNo ?? r.title!,
          title: r.title!,
          rawText: r.summary ?? r.title!,
          sourceUrl: r.url ?? 'https://www.kca.go.kr/',
          publishedDate: ymd(r.regDate),
        }));
    },
  };
}
