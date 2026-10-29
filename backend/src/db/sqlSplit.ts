// SQL 스크립트를 문장 단위로 나눈다. DELIMITER 지시문(트리거 블록), 따옴표·주석 안의 구분자를 처리한다(T015).
export interface SqlStatement {
  sql: string;
  /** 문장 바로 앞에 붙은 주석 줄들 — DDL 테스트 표지(-- @accept 등) 해석용 */
  leadingComments: string[];
  line: number;
}

export function splitSql(script: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let delimiter = ';';
  let buf = '';
  let comments: string[] = [];
  let startLine = 1;
  let line = 1;
  let i = 0;
  const n = script.length;
  let quote: string | null = null;

  const flush = () => {
    const sql = buf.trim();
    if (sql) out.push({ sql, leadingComments: comments, line: startLine });
    buf = '';
    comments = [];
  };

  while (i < n) {
    // 줄 시작에서 DELIMITER 지시문
    const atLineStart = i === 0 || script[i - 1] === '\n';
    if (!quote && atLineStart && buf.trim() === '') {
      const eol = script.indexOf('\n', i);
      const lineText = script.slice(i, eol === -1 ? n : eol);
      const m = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(lineText);
      if (m) {
        delimiter = m[1]!;
        i = eol === -1 ? n : eol + 1;
        line++;
        continue;
      }
      const c = /^\s*--(.*)$/.exec(lineText);
      if (c) {
        comments.push(c[1]!.trim());
        i = eol === -1 ? n : eol + 1;
        line++;
        continue;
      }
      if (lineText.trim() === '') {
        i = eol === -1 ? n : eol + 1;
        line++;
        continue;
      }
      startLine = line;
    }
    const ch = script[i]!;
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote !== '`') {
        buf += script[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      if (ch === '\n') line++;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      buf += ch;
      i++;
      continue;
    }
    // 문장 안의 줄 주석은 버린다
    if (ch === '-' && script[i + 1] === '-' && (script[i + 2] === ' ' || script[i + 2] === '\t' || script[i + 2] === '\n')) {
      const eol = script.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (ch === '/' && script[i + 1] === '*') {
      const end = script.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k++) if (script[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (script.startsWith(delimiter, i)) {
      flush();
      i += delimiter.length;
      continue;
    }
    if (ch === '\n') line++;
    buf += ch;
    i++;
  }
  flush();
  return out;
}
