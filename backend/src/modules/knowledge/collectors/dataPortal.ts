// 공공데이터포털 수집기(T130, 0.1 `KMS -> PUB`) — 공정거래위원회 표준약관 조항. 키 = DATA_PORTAL_KEY,
// 서비스 주소 = DATA_PORTAL_STD_TERMS_URL(데이터셋 활용 신청 후 받은 주소 — 기본값 없음). 응답은 data.go.kr 표준
// response.header.resultCode / response.body.items.item 형식을 따른다. 항목 필드 이름은 [추정] — 활용 명세로 확인 필요
import type { Collector, SinceKv, SourceDelta } from './index.js';
import { CollectorError, after, asArray, getJson, requireKey, ymd, type FetchLike } from './http.js';

interface StdTermsRow {
  stdTermsNm?: string;
  articleNo?: string;
  articleTitle?: string;
  articleCn?: string;
  revisionDate?: string;
  enforceDate?: string;
  url?: string;
}

interface PortalResponse {
  response?: {
    header?: { resultCode?: string; resultMsg?: string };
    body?: { items?: { item?: StdTermsRow | StdTermsRow[] } | StdTermsRow[]; totalCount?: number };
  };
}

export function dataPortalCollector(cfg: { serviceKey: string; url?: string; fetchImpl?: FetchLike }): Collector {
  return {
    agency: 'data_portal',
    async collect(since: SinceKv | null): Promise<SourceDelta[]> {
      const key = requireKey(cfg.serviceKey, 'DATA_PORTAL_KEY');
      if (!cfg.url) throw new CollectorError('주소 미설정 - DATA_PORTAL_STD_TERMS_URL');
      const out: SourceDelta[] = [];
      for (let page = 1; page <= 20; page++) {
        const sep = cfg.url.includes('?') ? '&' : '?';
        const res = await getJson<PortalResponse>(`${cfg.url}${sep}serviceKey=${encodeURIComponent(key)}&pageNo=${page}&numOfRows=100&type=json&resultType=json`, { fetchImpl: cfg.fetchImpl });
        const code = res.response?.header?.resultCode;
        if (code && code !== '00' && code !== '0') throw new CollectorError(`응답 오류(resultCode ${code})`);
        const items = res.response?.body?.items;
        const rows = Array.isArray(items) ? items : asArray(items?.item);
        for (const r of rows) {
          const revised = ymd(r.revisionDate);
          if (!r.stdTermsNm || !r.articleNo || !after(revised ?? ymd(r.enforceDate), since?.knowledgeDate)) continue;
          const identifier = `${r.articleNo}${r.articleTitle ? `(${r.articleTitle})` : ''}`;
          out.push({
            agency: 'data_portal',
            changeKind: 'std_terms_revision',
            sourceType: 'std_terms',
            sourceName: r.stdTermsNm,
            identifier,
            title: `${r.stdTermsNm} ${identifier} 개정`,
            rawText: `${identifier} ${r.articleCn ?? ''}`,
            sourceUrl: r.url || 'https://www.ftc.go.kr/www/cop/bbs/selectBoardList.do?key=201',
            effectiveDate: ymd(r.enforceDate) ?? revised,
            publishedDate: revised,
          });
        }
        if (rows.length < 100) break;
      }
      return out;
    },
  };
}
