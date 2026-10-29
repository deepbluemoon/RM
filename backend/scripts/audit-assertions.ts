// npm run audit:assertions [-- --db test] — 저장된 모든 설명 주장(explanation_claim)과 요약 문장(document.summary_text)을
// 단정 표현 사전(shared/assertion-terms.json)으로 전수 점검한다. 1건이라도 있으면 exit 1(SC-005, FR-029). CI test:backend 단계에서 돈다.
// 출력에는 위치(판정 ID·순번, 문서 ID)와 건수만 싣고 문장 원문은 싣지 않는다(비식별 텍스트라도 로그에 본문을 남기지 않는다 — FR-009)
if (process.argv.includes('--db') && process.argv[process.argv.indexOf('--db') + 1] === 'test') {
  // env.ts 가 읽기 전에 테스트 DB 로 바꾼다(tests/setup-env.ts 와 같은 규칙)
  const { config } = await import('dotenv');
  const parsed = config({ path: new URL('../.env', import.meta.url).pathname }).parsed ?? {};
  const e = { ...parsed, ...process.env };
  process.env.DB_HOST = e.TEST_DB_HOST ?? '127.0.0.1';
  process.env.DB_PORT = e.TEST_DB_PORT ?? '23610';
  process.env.DB_USER = e.TEST_DB_USER ?? e.DB_USER;
  process.env.DB_PASSWORD = e.TEST_DB_PASSWORD ?? e.DB_PASSWORD ?? '';
  process.env.DB_NAME = e.TEST_DB_NAME ?? 'crd_test';
}

const { getPool, select, closePool } = await import('../src/db/pool.js');
const { containsAssertion } = await import('../src/modules/results/explanation.filter.js');

/** 요약을 문장 단위로 나눈다(마침표·물음표·느낌표·줄바꿈) */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<number> {
  const hits: string[] = [];
  let claims = 0;
  let summaries = 0;
  const pageSize = 2000;
  for (let last = { j: 0, s: 0 }; ; ) {
    const rows = await select<{ judgment_id: number; seq: number; claim_text: string }>(
      getPool(),
      `SELECT judgment_id, seq, claim_text FROM explanation_claim
        WHERE (judgment_id, seq) > (?, ?) ORDER BY judgment_id, seq LIMIT ${pageSize}`,
      [last.j, last.s],
    );
    for (const r of rows) {
      claims++;
      if (containsAssertion(r.claim_text)) hits.push(`explanation_claim judgment_id=${r.judgment_id} seq=${r.seq}`);
    }
    if (rows.length < pageSize) break;
    last = { j: rows[rows.length - 1]!.judgment_id, s: rows[rows.length - 1]!.seq };
  }
  for (let lastId = 0; ; ) {
    const rows = await select<{ document_id: number; summary_text: string }>(
      getPool(),
      `SELECT document_id, summary_text FROM document
        WHERE summary_text IS NOT NULL AND document_id > ? ORDER BY document_id LIMIT ${pageSize}`,
      [lastId],
    );
    for (const r of rows) {
      summaries++;
      const bad = sentences(r.summary_text).filter(containsAssertion).length;
      if (bad) hits.push(`document.summary_text document_id=${r.document_id} (${bad}문장)`);
    }
    if (rows.length < pageSize) break;
    lastId = rows[rows.length - 1]!.document_id;
  }
  process.stdout.write(`점검: 설명 주장 ${claims}건, 요약 ${summaries}건 → 단정 표현 ${hits.length}건\n`);
  for (const h of hits) process.stdout.write(`  ${h}\n`);
  return hits.length ? 1 : 0;
}

const isMain = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (isMain) {
  main()
    .then((code) => (process.exitCode = code))
    .catch((e) => {
      process.stderr.write(`audit 실패: ${(e as Error).message}\n`);
      process.exitCode = 2;
    })
    .finally(() => closePool());
}
