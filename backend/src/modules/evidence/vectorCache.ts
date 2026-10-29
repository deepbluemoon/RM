// 근거 벡터 로컬 캐시(2026-09-30) — 검색 인덱스를 만들 때 DB 에서 받는 벡터(근거 1건 4KB, 2,547건 ≈ 10.5MB)를 줄인다.
// 근거 버전(evidence_version)과 그 임베딩(evidence_embedding: 버전·모델당 1개, 덮어쓰기 없음)은 바뀌지 않으므로 파일로 보관해도 된다.
// 안전장치
// - DB 마다 id 가 겹치므로(로컬 devdb·팀 DB) 캐시 파일 = (DB 호스트·포트·이름, 모델) 해시. 비밀번호는 쓰지 않는다.
// - DB 초기화로 같은 id 가 다른 근거가 될 수 있으므로 항목마다 근거 내용 해시를 저장하고, 읽을 때 현재 근거와 다르면 버린다.
// - 서버·평가 스크립트가 동시에 쓸 수 있으므로 임시 파일에 쓴 뒤 rename(원자적). 읽을 때 크기가 안 맞으면 캐시 전체를 무시한다.
// - 테스트(NODE_ENV=test)에서는 쓰지 않는다(테스트 DB 는 매번 초기화된다).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BACKEND_ROOT, env } from '../../config/env.js';
import { logger } from '../../logger.js';

export interface CachedVector { v: Float32Array; h: string }
interface CacheIndex { v: 1; model: string; dim: number; ids: number[]; hashes: string[] }

export const vectorCacheEnabled = (): boolean => env.RAG_VEC_CACHE === 'on' && env.NODE_ENV !== 'test';

/** 근거 내용 해시 — id 재사용(DB 초기화) 감지용 */
export function evidenceTextHash(r: { source_name: string; identifier: string; excerpt: string }): string {
  return createHash('sha1').update(`${r.source_name}\u0001${r.identifier}\u0001${r.excerpt}`).digest('hex').slice(0, 16);
}

function base(model: string): string {
  const key = createHash('sha1').update(`${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}|${model}`).digest('hex').slice(0, 20);
  return path.join(path.resolve(BACKEND_ROOT, env.RAG_VEC_CACHE_DIR), key);
}

export function readVectorCache(model: string): Map<number, CachedVector> | null {
  const b = base(model);
  try {
    if (!fs.existsSync(`${b}.json`) || !fs.existsSync(`${b}.bin`)) return null;
    const idx = JSON.parse(fs.readFileSync(`${b}.json`, 'utf8')) as CacheIndex;
    const buf = fs.readFileSync(`${b}.bin`);
    if (idx.v !== 1 || idx.model !== model || idx.ids.length !== idx.hashes.length || buf.byteLength !== idx.ids.length * idx.dim * 4) {
      logger.warn({ model }, 'vector cache size mismatch — ignored');
      return null;
    }
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const out = new Map<number, CachedVector>();
    idx.ids.forEach((id, i) => out.set(id, { v: all.slice(i * idx.dim, (i + 1) * idx.dim), h: idx.hashes[i]! }));
    return out;
  } catch (e) {
    logger.warn({ model, err: (e as Error).message }, 'vector cache unreadable — ignored');
    return null;
  }
}

export function writeVectorCache(model: string, entries: Map<number, CachedVector>): void {
  if (!entries.size) return;
  const b = base(model);
  const dim = entries.values().next().value!.v.length;
  const ids = [...entries.keys()].sort((a, c) => a - c);
  const all = new Float32Array(ids.length * dim);
  ids.forEach((id, i) => all.set(entries.get(id)!.v, i * dim));
  const idx: CacheIndex = { v: 1, model, dim, ids, hashes: ids.map((id) => entries.get(id)!.h) };
  try {
    fs.mkdirSync(path.dirname(b), { recursive: true });
    const tag = `${process.pid}.${Date.now()}`;
    fs.writeFileSync(`${b}.bin.${tag}`, Buffer.from(all.buffer));
    fs.writeFileSync(`${b}.json.${tag}`, JSON.stringify(idx));
    // .bin 을 먼저 바꾸고 .json 을 나중에 — 읽는 쪽은 크기 검증으로 중간 상태를 거른다
    fs.renameSync(`${b}.bin.${tag}`, `${b}.bin`);
    fs.renameSync(`${b}.json.${tag}`, `${b}.json`);
  } catch (e) {
    logger.warn({ model, err: (e as Error).message }, 'vector cache write failed');
  }
}
