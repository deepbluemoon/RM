// 근거 임베딩 적재(하이브리드 RAG, 2026-09-29) — 마이그레이션 006 evidence_embedding.
// 기준일의 시행 중 근거(v_evidence_in_force) 중 현재 임베딩 모델 벡터가 없는 것만 채운다(멱등 — 다시 돌려도 빠진 것만).
// 공유 Ollama 가이드 1.7-7: 32개씩 보내고 묶음 사이 1초 쉰다. 저장은 묶음마다 짧은 자동 커밋(긴 트랜잭션·모델 호출 중 연결 점유 금지).
// 벡터가 없으면 검색은 BM25 만으로 동작하므로, 이 작업의 실패가 분석을 막지 않는다.
import { exec, getPool, select, type Db } from '../../db/pool.js';
import type { KvId } from '../../domain/types.js';
import { modelApi } from '../modelApi/client.js';
import { logger } from '../../logger.js';

export const EMBED_BATCH = 32;
export const EMBED_PAUSE_MS = 1000;
const MAX_CHARS = 8000;

/** 근거 1건의 임베딩 입력 — 출처·식별정보 + (사례면 문제 조항) + 발췌. 조항 문구와 가장 가까운 부분을 앞에 둔다 */
export function evidenceEmbedText(r: { source_name: string; identifier: string; excerpt: string; case_facts?: string | null }): string {
  const head = `${r.source_name} ${r.identifier}`;
  const body = r.case_facts ? `${r.case_facts}\n${r.excerpt}` : r.excerpt;
  return `${head}\n${body}`.slice(0, MAX_CHARS);
}

/** VECTOR 컬럼 입력 형식(VEC_FromText) */
export const vecText = (v: number[]): string => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;

async function currentModel(): Promise<string> {
  return (await modelApi.embed(['모델 버전 확인'])).model_version;
}

export async function missingEmbeddings(kvId: KvId, model: string, db: Db = getPool()) {
  return select<{ evidence_version_id: number; source_name: string; identifier: string; excerpt: string; case_facts: string | null }>(
    db,
    `SELECT v.evidence_version_id, v.source_name, v.identifier, v.excerpt, ev.case_facts
       FROM v_evidence_in_force v
       JOIN evidence_version ev ON ev.evidence_version_id = v.evidence_version_id
       LEFT JOIN evidence_embedding e ON e.evidence_version_id = v.evidence_version_id AND e.model = ?
      WHERE v.kv_id = ? AND e.evidence_version_id IS NULL
      ORDER BY v.evidence_version_id`,
    [model, kvId],
  );
}

export async function embedEvidence(kvId: KvId, opts: { limit?: number; sleep?: (ms: number) => Promise<void>; log?: (s: string) => void } = {}) {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = opts.log ?? (() => undefined);
  const model = await currentModel();
  let todo = await missingEmbeddings(kvId, model);
  if (opts.limit) todo = todo.slice(0, opts.limit);
  let done = 0;
  const t0 = Date.now();
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const part = todo.slice(i, i + EMBED_BATCH);
    const res = await modelApi.embed(part.map(evidenceEmbedText));
    if (res.model_version !== model) throw new Error(`임베딩 모델이 작업 중 바뀌었습니다(${model} → ${res.model_version})`);
    await exec(getPool(),
      `INSERT INTO evidence_embedding (evidence_version_id, model, embedding) VALUES ${part.map(() => '(?,?,VEC_FromText(?))').join(',')}
       ON DUPLICATE KEY UPDATE evidence_version_id = evidence_version_id`,
      part.flatMap((r, k) => [r.evidence_version_id, model, vecText(res.embeddings[k]!)]));
    done += part.length;
    say(`${done}/${todo.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
    if (i + EMBED_BATCH < todo.length) await sleep(EMBED_PAUSE_MS);
  }
  logger.info({ kvId, model, embedded: done }, 'evidence embeddings filled');
  return { model, embedded: done, remaining: (await missingEmbeddings(kvId, model)).length };
}
