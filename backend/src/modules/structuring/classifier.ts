// 계약서 판별(T069, research R-08, G6): 조 구조 수·계약 어휘 밀도·길이로 점수화
import { countArticles } from './splitter.js';

const VOCAB = ['계약', '약관', '당사자', '해지', '해제', '위약금', '환불', '이용료', '계약기간', '갑', '을', '회원', '회사', '효력', '손해배상', '청약철회', '의무', '권리', '이용자', '서비스', '동의', '통지', '분쟁', '관할', '시행', '구독', '할부', '대금'];

export interface ContractScore {
  isContract: boolean;
  score: number;
  articles: number;
  vocabHits: number;
  distinctTerms: number;
  length: number;
}

export function classifyContract(text: string): ContractScore {
  const compact = text.replace(/\s+/g, ' ');
  const length = compact.length;
  const articles = countArticles(text);
  let vocabHits = 0;
  let distinct = 0;
  for (const w of VOCAB) {
    // 한 글자 낱말(갑·을)은 표지 형태로만 센다
    const re = w.length === 1 ? new RegExp(`(^|[\\s(])${w}(은|는|이|가|의|과|와|\\s|:|$)`, 'g') : new RegExp(w, 'g');
    const n = (compact.match(re) ?? []).length;
    vocabHits += n;
    if (n) distinct++;
  }
  const density = length ? (vocabHits * 1000) / length : 0;
  const score = Math.min(1, (articles >= 3 ? 0.5 : articles * 0.1) + Math.min(0.3, density / 40) + Math.min(0.2, distinct / 30));
  const isContract = length >= 80 && ((articles >= 3 && distinct >= 3) || (distinct >= 5 && density >= 8 && length >= 200));
  return { isContract, score: Math.round(score * 100) / 100, articles, vocabHits, distinctTerms: distinct, length };
}
