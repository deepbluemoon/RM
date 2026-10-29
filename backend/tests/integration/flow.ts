// US1 흐름 도우미 — 업로드/텍스트 → 분석 시작 → 유형 확정 → 완료 → 저장
import fs from 'node:fs';
import { expect } from 'vitest';
import { fixture, waitFor, type newAgent } from './setup.js';
import { expectResponse } from '../contract/harness.js';

type Agent = ReturnType<typeof newAgent>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StatusBody = any;

export async function upload(agent: Agent, file: string) {
  const r = await agent.post('/api/intake/uploads').attach('file', fs.readFileSync(fixture(file)), file.split('/').pop()!);
  return r;
}

export async function startFile(agent: Agent, file: string, perspective: 'consumer' | 'business' = 'consumer') {
  const up = await upload(agent, file);
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  expectResponse('web', 'POST', '/intake/uploads', 201, up.body);
  const r = await agent.post('/api/analyses').send({ perspective, source: { kind: 'file', uploadToken: up.body.uploadToken } });
  return r;
}

export async function startText(agent: Agent, text: string, perspective: 'consumer' | 'business' = 'consumer') {
  return agent.post('/api/analyses').send({ perspective, source: { kind: 'text', text } });
}

export async function status(agent: Agent, requestId: number): Promise<StatusBody> {
  const r = await agent.get(`/api/analyses/${requestId}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expectResponse('web', 'GET', '/analyses/{requestId}', 200, r.body);
  return r.body;
}

export async function waitStage(agent: Agent, requestId: number, pred: (s: StatusBody) => boolean, timeoutMs = 30_000): Promise<StatusBody> {
  return waitFor(() => status(agent, requestId), pred, timeoutMs);
}

/** 유형 확정까지 진행하고 결과 저장(runId 반환) */
export async function analyzeToSaved(agent: Agent, start: () => Promise<{ status: number; body: { requestId: number } }>, contractType = 'subscription') {
  const s = await start();
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const requestId = s.body.requestId;
  const st = await waitStage(agent, requestId, (x) => x.requestStage === 'awaiting_type' || x.requestStage === 'stopped');
  expect(st.requestStage).toBe('awaiting_type');
  for (const d of st.documents as { documentId: number }[]) {
    const put = await agent.put(`/api/analyses/${requestId}/documents/${d.documentId}/contract-type`).send({ contractType });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  const done = await waitStage(agent, requestId, (x) => !!x.run && ['completed', 'aborted'].includes(x.run.stage));
  expect(done.run.stage).toBe('completed');
  const runId = done.run.runId as number;
  const save = await agent.post(`/api/analyses/${requestId}/runs/${runId}/save`);
  expect(save.status, JSON.stringify(save.body)).toBe(200);
  expectResponse('web', 'POST', '/analyses/{requestId}/runs/{runId}/save', 200, save.body);
  return { requestId, runId, status: st };
}
