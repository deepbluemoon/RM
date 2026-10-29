// 조항 분할(T070, research R-08, FR-011·012): 조(제N조) → 항(①…⑳) → 호(1. / 가.) 정규식 파서.
// 조 번호가 3개 미만이면 문단·번호 목록 기준 의미 단위 분할(split_method='semantic').
// 위치(조 번호·제목·순서)를 보존한다. 부칙의 조는 "부칙 제N조"로 표기해 같은 문서에 둔다.
// 결합된 복수 계약(제1조 재시작·약관 제목 재등장)의 문서 경계는 findDocumentStarts(T103, UC1 A5)가 찾는다.
export interface ParsedItem {
  itemNo: string;
  text: string;
}
export interface ParsedParagraph {
  paragraphNo: string | null;
  text: string;
  items: ParsedItem[];
}
export interface ParsedArticle {
  articleNo: string;
  title: string | null;
  paragraphs: ParsedParagraph[];
}

export interface SplitClause {
  seq: number;
  articleNo: string | null;
  paragraphNo: string | null;
  itemNo: string | null;
  title: string | null;
  text: string;
}

export interface SplitResult {
  method: 'article' | 'semantic';
  clauses: SplitClause[];
  articles: ParsedArticle[];
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
export const ARTICLE_RE = /^\s*(부\s*칙\s*)?제\s*(\d{1,3})\s*조(?:\s*의\s*(\d{1,2}))?\s*(?:[(（[]\s*([^)）\]]{1,60}?)\s*[)）\]])?\s*(.*)$/;
const PARA_RE = new RegExp(`^\\s*([${CIRCLED}])\\s*(.*)$`);
const ITEM_RE = /^\s*(\d{1,2}\.|[가나다라마바사아자차카타파하]\.|\d{1,2}\))\s+(.*)$/;
const ADDENDA_RE = /^\s*부\s*칙\s*(?:[<(（].*)?$/;

/** PDF 줄바꿈으로 끊긴 문장을 잇는다 — 구조 표지로 시작하지 않는 줄은 앞 줄에 붙인다 */
export function joinWrappedLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    const t = line.trim();
    if (!t) {
      out.push('');
      continue;
    }
    const isMarker = ARTICLE_RE.test(t) || PARA_RE.test(t) || ITEM_RE.test(t) || ADDENDA_RE.test(t);
    const prev = out[out.length - 1];
    // 제목만 있는 조 머리말("제2조(정의)") 뒤 줄은 새 문단이다. 머리말에 본문이 이어지면 다음 줄을 붙인다
    const prevIsBareHeader = prev !== undefined && (() => {
      const m = ARTICLE_RE.exec(prev);
      return !!m && !(m[5] ?? '').trim();
    })();
    const continues = prev !== undefined && prev !== '' && !prevIsBareHeader && !ADDENDA_RE.test(prev) && (!/[.。!?:：]$/.test(prev) || /[,，·]$/.test(prev));
    if (!isMarker && continues) out[out.length - 1] = `${prev} ${t}`;
    else out.push(t);
  }
  return out;
}

export function countArticles(text: string): number {
  return joinWrappedLines(text).filter((l) => ARTICLE_RE.test(l) && !/^\s*제\s*\d+\s*조\s*(?:제\s*\d+\s*항)?\s*(에|의|을|를|과|와|에서|부터)/.test(l)).length;
}

/** 조 머리말인가 — 본문 속 인용("제3조에 따라")은 머리말이 아니다 */
function articleHeader(line: string): RegExpExecArray | null {
  const a = ARTICLE_RE.exec(line);
  if (!a) return null;
  return !a[5] || !/^(에|의|을|를|과|와|에서|부터|및)/.test(a[5].trim()) ? a : null;
}

// 약관·계약서 제목 줄(UC1 A5): 짧고, 문장 부호로 끝나지 않고, "…약관"/"…계약서" 로 끝난다(개정 표기 괄호는 허용)
const TITLE_RE = /(약관|계약서|계약|규약)\s*(?:[(（<〈[][^)）>〉\]]{0,30}[)）>〉\]])?$/;
export function isTitleLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 4 || t.length > 60) return false;
  if (ARTICLE_RE.test(t) || PARA_RE.test(t) || ITEM_RE.test(t) || ADDENDA_RE.test(t)) return false;
  // 문장 조각(줄바꿈으로 끊긴 "회원은 이 계약")은 제목이 아니다 — 주격·목적격 조사 뒤 띄어쓰기가 있으면 문장으로 본다
  if (/[.。!?:：,，]$/.test(t) || /^(이|본|위|상기)\s/.test(t) || /(한다|된다|있다|없다|이다)/.test(t) || /[가-힣](은|는|을|를)\s/.test(t)) return false;
  return TITLE_RE.test(t);
}

/** 결합된 복수 계약의 문서 시작 줄 번호(UC1 A5, research R-08).
 *  앞 문서에 조가 3개 이상 나온 뒤 (1) 약관·계약서 제목이 다시 나오거나 (2) 제1조가 다시 시작되면 새 문서다.
 *  부칙 안의 제1조 재시작은 같은 문서로 본다. 새 문서의 조가 3개 미만이면 앞 문서에 붙인다 */
export function findDocumentStarts(lines: string[]): number[] {
  const starts = [0];
  const counts = [0];
  let addenda = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line) continue;
    const cur = counts.length - 1;
    if (ADDENDA_RE.test(line)) {
      addenda = true;
      continue;
    }
    if (counts[cur]! >= 3 && isTitleLine(line)) {
      starts.push(i);
      counts.push(0);
      addenda = false;
      continue;
    }
    const a = articleHeader(line);
    if (!a) continue;
    if (!a[1] && !addenda && !a[3] && Number(a[2]) === 1 && counts[cur]! >= 3) {
      starts.push(i);
      counts.push(0);
    }
    counts[counts.length - 1]!++;
  }
  // 조가 3개 미만인 조각은 앞 문서에 붙인다
  for (let k = starts.length - 1; k > 0; k--) {
    if (counts[k]! < 3) {
      starts.splice(k, 1);
      counts[k - 1]! += counts[k]!;
      counts.splice(k, 1);
    }
  }
  return starts;
}

function parseArticles(lines: string[]): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  let cur: ParsedArticle | null = null;
  let para: ParsedParagraph | null = null;
  let addenda = false;
  for (const line of lines) {
    if (!line) continue;
    if (ADDENDA_RE.test(line)) {
      addenda = true;
      continue;
    }
    // 본문 속 인용("제3조에 따라")은 조 머리말로 보지 않는다
    const a = articleHeader(line);
    if (a) {
      const no = `${addenda || a[1] ? '부칙 ' : ''}제${a[2]}조${a[3] ? `의${a[3]}` : ''}`;
      cur = { articleNo: no, title: a[4]?.trim() || null, paragraphs: [] };
      articles.push(cur);
      para = null;
      const rest = (a[5] ?? '').trim();
      if (rest) {
        const p = PARA_RE.exec(rest);
        para = p ? { paragraphNo: p[1]!, text: p[2]!.trim(), items: [] } : { paragraphNo: null, text: rest, items: [] };
        cur.paragraphs.push(para);
      }
      continue;
    }
    if (!cur) continue; // 첫 조 앞의 제목·전문은 조항이 아니다
    const p = PARA_RE.exec(line);
    if (p) {
      para = { paragraphNo: p[1]!, text: p[2]!.trim(), items: [] };
      cur.paragraphs.push(para);
      continue;
    }
    const it = ITEM_RE.exec(line);
    if (it && para) {
      para.items.push({ itemNo: it[1]!.replace(/[.)]$/, ''), text: it[2]!.trim() });
      continue;
    }
    if (!para) {
      para = { paragraphNo: null, text: line, items: [] };
      cur.paragraphs.push(para);
    } else if (para.items.length) {
      const last = para.items[para.items.length - 1]!;
      last.text = `${last.text} ${line}`;
    } else {
      para.text = `${para.text} ${line}`;
    }
  }
  return articles;
}

/** 조·항 단위 조항 목록 — 호는 항 본문 안에 남겨 문맥을 유지한다 */
function articlesToClauses(articles: ParsedArticle[]): SplitClause[] {
  const out: SplitClause[] = [];
  for (const a of articles) {
    if (!a.paragraphs.length) {
      if (a.title) out.push({ seq: out.length + 1, articleNo: a.articleNo, paragraphNo: null, itemNo: null, title: a.title, text: a.title });
      continue;
    }
    for (const p of a.paragraphs) {
      const items = p.items.map((i) => `${i.itemNo}. ${i.text}`).join('\n');
      out.push({
        seq: out.length + 1,
        articleNo: a.articleNo,
        paragraphNo: p.paragraphNo,
        itemNo: null,
        title: a.title,
        text: [p.text, items].filter(Boolean).join('\n'),
      });
    }
  }
  return out;
}

const MAX_SEMANTIC = 600;

function semanticSplit(lines: string[]): SplitClause[] {
  const blocks: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) blocks.push(buf.join(' ').trim());
    buf = [];
  };
  for (const l of lines) {
    if (!l) flush();
    else if (ITEM_RE.test(l) || PARA_RE.test(l)) {
      flush();
      buf.push(l);
    } else buf.push(l);
  }
  flush();
  // 너무 짧은 조각은 다음 조각과 합치고, 너무 긴 조각은 문장 경계에서 나눈다
  const merged: string[] = [];
  for (const b of blocks.filter(Boolean)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length < 20) merged[merged.length - 1] = `${last} ${b}`;
    else merged.push(b);
  }
  const out: SplitClause[] = [];
  for (const b of merged) {
    if (b.length <= MAX_SEMANTIC) {
      out.push({ seq: out.length + 1, articleNo: null, paragraphNo: null, itemNo: null, title: null, text: b });
      continue;
    }
    let chunk = '';
    for (const s of b.split(/(?<=[.。!?])\s+/)) {
      if (chunk && chunk.length + s.length > MAX_SEMANTIC) {
        out.push({ seq: out.length + 1, articleNo: null, paragraphNo: null, itemNo: null, title: null, text: chunk.trim() });
        chunk = '';
      }
      chunk += `${s} `;
    }
    if (chunk.trim()) out.push({ seq: out.length + 1, articleNo: null, paragraphNo: null, itemNo: null, title: null, text: chunk.trim() });
  }
  return out;
}

export function splitClauses(text: string): SplitResult {
  const lines = joinWrappedLines(text);
  const articles = parseArticles(lines);
  if (articles.length >= 3) return { method: 'article', clauses: articlesToClauses(articles), articles };
  return { method: 'semantic', clauses: semanticSplit(lines), articles: [] };
}
