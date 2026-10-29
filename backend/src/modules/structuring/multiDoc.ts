// 결합된 복수 계약 분리(T103, UC1 A5, spec Edge Case "결합된 복수 계약"): 한 파일 안에서 제1조가 다시 시작되거나
// 약관·계약서 제목이 다시 나오면 문서를 나눈다(document.doc_seq 증가). 각 문서는 따로 조항 분할한다
import { findDocumentStarts, isTitleLine, joinWrappedLines, splitClauses, type SplitResult } from './splitter.js';

export interface SplitDocument extends SplitResult {
  /** 문서 첫머리의 약관·계약서 제목(없으면 null) — 복수 문서일 때 표시명으로 쓴다 */
  title: string | null;
}

export function splitDocuments(text: string): SplitDocument[] {
  const lines = joinWrappedLines(text);
  const starts = findDocumentStarts(lines);
  return starts.map((from, i) => {
    const seg = lines.slice(from, starts[i + 1] ?? lines.length);
    const firstArticle = seg.findIndex((l) => /^\s*(부\s*칙\s*)?제\s*\d{1,3}\s*조/.test(l));
    const title = seg.slice(0, firstArticle < 0 ? 3 : firstArticle).find((l) => l && isTitleLine(l))?.trim() ?? null;
    return { ...splitClauses(seg.join('\n')), title };
  });
}
