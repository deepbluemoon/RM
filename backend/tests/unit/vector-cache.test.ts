// 근거 벡터 로컬 캐시(2026-09-30) — 왕복 저장·크기 불일치 무시·내용 해시
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BACKEND_ROOT, env } from '../../src/config/env.js';
import { evidenceTextHash, readVectorCache, vectorCacheEnabled, writeVectorCache } from '../../src/modules/evidence/vectorCache.js';

const MODEL = `unit-test-model-${process.pid}`;
const dir = path.resolve(BACKEND_ROOT, env.RAG_VEC_CACHE_DIR);
const mine = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => {
  const j = f.endsWith('.json') ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
  return j?.model === MODEL;
}).flatMap((f) => [f, f.replace(/\.json$/, '.bin')]);
afterAll(() => { for (const f of mine()) fs.rmSync(path.join(dir, f), { force: true }); });

describe('근거 벡터 캐시', () => {
  it('테스트 환경에서는 서비스 경로의 캐시를 쓰지 않는다', () => {
    expect(vectorCacheEnabled()).toBe(false);
  });

  it('저장한 벡터·해시를 그대로 읽는다', () => {
    const v1 = Float32Array.from({ length: 4 }, (_, i) => i / 4);
    const v2 = Float32Array.from({ length: 4 }, (_, i) => -i);
    writeVectorCache(MODEL, new Map([[11, { v: v1, h: 'aaaa' }], [7, { v: v2, h: 'bbbb' }]]));
    const got = readVectorCache(MODEL)!;
    expect([...got.keys()].sort()).toEqual([11, 7].sort());
    expect(Array.from(got.get(11)!.v)).toEqual(Array.from(v1));
    expect(got.get(7)!.h).toBe('bbbb');
  });

  it('.bin 크기가 맞지 않으면(손상·쓰기 중) 캐시 전체를 무시한다', () => {
    const bin = mine().find((f) => f.endsWith('.bin'))!;
    fs.truncateSync(path.join(dir, bin), 3);
    expect(readVectorCache(MODEL)).toBeNull();
  });

  it('근거 내용이 바뀌면 해시가 달라진다(id 재사용 감지)', () => {
    const a = evidenceTextHash({ source_name: '약관의 규제에 관한 법률', identifier: '제6조 제1항', excerpt: '신의성실' });
    const b = evidenceTextHash({ source_name: '약관의 규제에 관한 법률', identifier: '제6조 제1항', excerpt: '신의성실 원칙' });
    expect(a).not.toBe(b);
  });
});
