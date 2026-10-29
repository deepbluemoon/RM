// T106 — 개인정보 누출 전수 점검(SC-013, A14): 표본 계약서(T105)를 분석한 뒤
//  (1) information_schema 로 찾은 전 테이블의 문자열 열, (2) 캡처한 pino 출력, (3) 모든 API 응답(본문·헤더),
//  (4) 스텁이 받은 모델 API 요청 본문에서 표본 원문 값을 찾아 0건인지 확인한다. display_name 도 가려져야 한다
import fs from 'node:fs';
import type { Server } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, loginAs, resetDb, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved } from './flow.js';
import { createApp } from '../../src/app.js';
import { setLoggerDestination } from '../../src/logger.js';
import { getPool, select } from '../../src/db/pool.js';
import { supportedFormats } from '../../src/modules/extract/index.js';
import { PII_CONTRACT_TEXT, PII_FILE_BASENAME, PII_SECRETS } from '../fixtures/pii/contract-with-pii.js';

const logLines: string[] = [];
const responses: string[] = [];
const servers: Server[] = [];
let stub: StubHandle;

/** 응답 본문·헤더를 모두 기록하는 앱 — createApp() 을 바깥에서 감싼다 */
function capturingAgent() {
  const outer = express();
  outer.use((req, res, next) => {
    const chunks: Buffer[] = [];
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    const end = res.end.bind(res) as (...a: unknown[]) => unknown;
    const push = (c: unknown) => {
      if (typeof c === 'string' || Buffer.isBuffer(c)) chunks.push(Buffer.from(c as string));
    };
    (res as unknown as { write: (...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      push(c);
      return write(c, ...a);
    };
    (res as unknown as { end: (...a: unknown[]) => unknown }).end = (c: unknown, ...a: unknown[]) => {
      push(c);
      responses.push(`${req.method} ${req.originalUrl} ${JSON.stringify(res.getHeaders())}\n${Buffer.concat(chunks).toString('utf8')}`);
      return end(c, ...a);
    };
    next();
  });
  outer.use(createApp());
  // 호스트 없이 listen — 즉시 bind 되어 supertest 가 다른 포트로 다시 listen 하는 경합을 피한다(setup.newAgent 와 같다)
  const server = outer.listen(0);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  servers.push(server);
  return supertest.agent(server);
}
type Agent = ReturnType<typeof capturingAgent>;

async function uploadAndStart(agent: Agent, file: string, name: string) {
  const up = await agent.post('/api/intake/uploads').attach('file', fs.readFileSync(fixture(file)), name);
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  return agent.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'file', uploadToken: up.body.uploadToken } });
}

/** 결과 화면이 부르는 조회를 모두 부른다(응답 점검 대상) */
async function browseResult(agent: Agent, runId: number) {
  const r = await agent.get(`/api/results/${runId}`).expect(200);
  for (const c of r.body.clauses as { assessmentId: number; displayCategory: string }[]) {
    await agent.get(`/api/results/${runId}/clauses/${c.assessmentId}`).expect(200);
    if (c.displayCategory !== 'normal' && c.displayCategory !== 'unanalyzable') {
      await agent.get(`/api/results/${runId}/clauses/${c.assessmentId}/explanation`);
      await agent.get(`/api/results/${runId}/clauses/${c.assessmentId}/comparison`);
      await agent.get(`/api/results/${runId}/clauses/${c.assessmentId}/similar-cases`);
    }
  }
  return r.body as { requestId: number; clauses: { assessmentId: number; displayCategory: string }[]; documents: { displayName: string }[] };
}

function hits(haystack: string, where: string): string[] {
  return PII_SECRETS.filter((s) => haystack.includes(s.value)).map((s) => `${where}: ${s.type} ${s.value}`);
}

beforeAll(async () => {
  setLoggerDestination({ write: (s: string) => void logLines.push(s) }, 'debug');
  await resetDb();
  stub = await startStub({ recordBodies: true });
});
afterAll(async () => {
  setLoggerDestination({ write: () => undefined }, 'silent');
  await stub.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await teardown();
});

describe('US4 개인정보 누출 점검(SC-013)', () => {
  // 두 계정으로 나눈다 — A: PDF·텍스트, B: DOCX·PDF·기록·피드백
  const anon = capturingAgent();
  const member = capturingAgent();
  const displayNames: string[] = [];
  beforeAll(async () => {
    await loginAs(anon, 'pii-a');
    await loginAs(member, 'pii-b');
  });

  it('브라우저 A — PDF 표본(파일명에 이름) 분석·결과 열람', async () => {
    const r = await analyzeToSaved(anon, () => uploadAndStart(anon, 'pii/contract-with-pii.pdf', `${PII_FILE_BASENAME}.pdf`), 'general_consumer');
    const view = await browseResult(anon, r.runId);
    displayNames.push(...view.documents.map((d) => d.displayName));
    // 문서 표시명도 비식별(A14). 파일명이 제대로 복원된 경우 이름 자리는 가림 표기다
    // 파일명의 한글이 그대로 복원되고(intake utf8FileName) 이름만 가려진다(A14)
    expect(view.documents[0]!.displayName).toContain('피트니스');
    expect(view.documents[0]!.displayName).toContain('〔이름〕');
  });

  it('브라우저 A — 붙여넣은 텍스트 표본 분석', async () => {
    const r = await analyzeToSaved(anon, () => anon.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'text', text: PII_CONTRACT_TEXT } }), 'general_consumer');
    await browseResult(anon, r.runId);
  });

  it.skipIf(!supportedFormats().includes('docx'))('브라우저 B — DOCX 표본 분석', async () => {
    const r = await analyzeToSaved(member, () => uploadAndStart(member, 'pii/contract-with-pii.docx', `${PII_FILE_BASENAME}.docx`), 'general_consumer');
    await browseResult(member, r.runId);
  });

  it('브라우저 B — PDF 표본 분석, 기록 목록·열람, 개인정보가 든 피드백 의견', async () => {
    const r = await analyzeToSaved(member, () => uploadAndStart(member, 'pii/contract-with-pii.pdf', `${PII_FILE_BASENAME}.pdf`), 'general_consumer');
    const view = await browseResult(member, r.runId);
    await member.get('/api/history').expect(200);
    await member.get(`/api/history/${r.requestId}`).expect(200);
    await member.get(`/api/results/${r.runId}/impacts`).expect(200);
    const opinion = '제 이름은 김민준입니다. 연락처 010-2345-6789, 주민등록번호 850315-1234567 로 확인해 주세요';
    const p = await member.post('/api/feedback/preview').send({ opinion }).expect(200);
    expect(p.body.opinionDeid).toContain('〔');
    const target = view.clauses.find((c) => c.displayCategory !== 'normal' && c.displayCategory !== 'unanalyzable') ?? view.clauses[0]!;
    const type = ['normal', 'unanalyzable'].includes(target.displayCategory) ? 'false_negative' : 'false_positive';
    await member.post('/api/feedback').send({ assessmentId: target.assessmentId, feedbackType: type, opinion }).expect(201);
  });

  it('표시명은 원문 이름 없이 저장된다(A14)', async () => {
    for (const n of displayNames) expect(hits(n, 'displayName')).toEqual([]);
    const docs = await select<{ display_name: string }>(getPool(), 'SELECT display_name FROM document');
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) expect(hits(d.display_name, 'document.display_name')).toEqual([]);
  });

  it('(1) DB 전 테이블 문자열 열 — 원문 값 0건', async () => {
    const cols = await select<{ table_name: string; column_name: string }>(
      getPool(),
      `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name
         FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'
          AND c.DATA_TYPE IN ('char','varchar','tinytext','text','mediumtext','longtext','json','binary','varbinary','tinyblob','blob','mediumblob','longblob')`,
    );
    expect(cols.length).toBeGreaterThan(20);
    const found: string[] = [];
    for (const c of cols) {
      const expr = `CAST(\`${c.column_name}\` AS CHAR CHARACTER SET utf8mb4)`;
      const where = PII_SECRETS.map(() => `${expr} LIKE ?`).join(' OR ');
      const rows = await select<{ v: string }>(getPool(), `SELECT ${expr} AS v FROM \`${c.table_name}\` WHERE ${where}`, PII_SECRETS.map((s) => `%${s.value}%`));
      for (const r of rows) found.push(...hits(String(r.v), `${c.table_name}.${c.column_name}`));
    }
    expect(found).toEqual([]);
  });

  it('(2) 로그 출력 — 원문 값 0건', () => {
    expect(logLines.length).toBeGreaterThan(0);
    expect(hits(logLines.join(''), 'log')).toEqual([]);
  });

  it('(3) 모든 API 응답 — 원문 값 0건', () => {
    expect(responses.length).toBeGreaterThan(20);
    const found = responses.flatMap((r) => hits(r, r.split('\n')[0]!.slice(0, 80)));
    expect(found).toEqual([]);
  });

  it('(4) 모델 API 요청 본문 — 원문 값 0건', () => {
    expect(stub.received.length).toBeGreaterThan(0);
    const found = stub.received.flatMap((r) => hits(JSON.stringify(r.body), r.path));
    expect(found).toEqual([]);
  });
});
