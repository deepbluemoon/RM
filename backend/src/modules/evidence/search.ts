// 근거 검색(T073, research R-09, FR-017·022·023): 명시 참조 우선 + 한글 2-gram BM25(기준일별 메모리 인덱스) + 유형 힌트 가중치.
// 상위 5개(출처 유형별 최대 3). 같은 입력이면 같은 순위(결정적 — 동점은 evidence_version_id 오름차순).
// 하이브리드 RAG(2026-09-29): 기준일 인덱스에 근거 벡터(evidence_embedding, bge-m3)를 함께 올리고, 조항을 /v1/embed 로 임베딩해
// BM25 순위와 코사인 순위를 RRF(k=60)로 합친다. 벡터가 없거나 게이트웨이가 실패하면 BM25 만(기존 동작 그대로).
// 튜닝(2026-09-30, 하이브리드 경로에서만): ① 코사인 가중 RRF ② 상위 유사 공정위 사례의 근거 법조(case_basis)로 법령 조문 가산
// ③ 상위 결과에 법령 최소 개수 보장. 기본값은 env RAG_DENSE_WEIGHT·RAG_CASE_EXPAND·RAG_MIN_LAW, 평가는 hints.tuning 으로 바꾼다.
import { createHash } from 'node:crypto';
import type { KvId } from '../../domain/types.js';
import type { RiskType, SourceType } from '../../domain/codes.js';
import { env } from '../../config/env.js';
import { getPool, select } from '../../db/pool.js';
import { logger } from '../../logger.js';
import { modelApi } from '../modelApi/client.js';
import { evidenceInForce, type EvidenceRow } from './evidence.repo.js';
import { evidenceTextHash, readVectorCache, vectorCacheEnabled, writeVectorCache, type CachedVector } from './vectorCache.js';

export const TOP_K = 5;
export const MAX_PER_SOURCE = 3;

/** 법령 약칭 사전 — 약칭·정식 명칭 → 정식 명칭 */
export const LAW_ALIASES: [RegExp, string][] = [
  [/약관의\s*규제에\s*관한\s*법률|약관규제법|약관법/g, '약관의 규제에 관한 법률'],
  [/전자상거래\s*등에서의\s*소비자보호에\s*관한\s*법률|전자상거래법|전상법|전자상거래소비자보호법/g, '전자상거래 등에서의 소비자보호에 관한 법률'],
  [/소비자기본법/g, '소비자기본법'],
  [/할부거래에\s*관한\s*법률|할부거래법/g, '할부거래에 관한 법률'],
  [/방문판매\s*등에\s*관한\s*법률|방문판매법|방판법/g, '방문판매 등에 관한 법률'],
];

const RISK_HINT_TERMS: Record<RiskType, string> = {
  rights_limit: '권리 제한 배제 소송 제기 항변권 포기 입증책임',
  liability_avoid: '책임 배제 면책 손해배상 범위 제한 고의 과실',
  refund_cancel_limit: '청약철회 환급 해제 해지 원상회복 반환',
  unilateral_change: '일방적 변경 급부 내용 중지 사전 고지 통지',
  excessive_penalty: '손해배상 위약금 과중 지연 손해금',
  vague: '해석 명백 불리 설명',
  other: '공정성 신의성실',
};

export function tokenize(text: string): string[] {
  const out: string[] = [];
  const norm = text.toLowerCase();
  for (const run of norm.match(/[가-힣]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  for (const w of norm.match(/[a-z0-9]+/g) ?? []) out.push(w);
  return out;
}

interface Doc {
  row: EvidenceRow;
  tf: Map<string, number>;
  len: number;
}

interface Index {
  kvId: KvId;
  docs: Doc[];
  df: Map<string, number>;
  avgLen: number;
  /** 근거 벡터(evidence_version_id → L2 정규화 float32). 기준일 안에서 가장 많이 채워진 모델 하나만 */
  vec: Map<number, Float32Array>;
  vecModel: string | null;
  vecLoadedAt: number;
  /** 공정위 사례 evidence_version_id → 근거 법조에서 읽은 법령 조문 키("법령명|제N조") */
  caseLaw: Map<number, string[]>;
  /** 법령 조문 키("법령명|제N조") → 해당 조의 법령 근거(항 단위) evidence_version_id */
  lawByArticle: Map<string, number[]>;
}

const artKey = (identifier: string): string | null => {
  const m = /^\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/.exec(identifier);
  return m ? `제${m[1]}조${m[2] ? `의${m[2]}` : ''}` : null;
};

/** 사례 근거 법조 → 법령 조문 키. explicitRefs 로 약칭을 정식 명칭으로 바꾼다 */
async function loadCaseLaw(idx: Index): Promise<void> {
  idx.lawByArticle = new Map();
  for (const d of idx.docs) {
    if (d.row.source_type !== 'law_article') continue;
    const a = artKey(d.row.identifier);
    if (!a) continue;
    const k = `${d.row.source_name}|${a}`;
    idx.lawByArticle.set(k, [...(idx.lawByArticle.get(k) ?? []), d.row.evidence_version_id]);
  }
  idx.caseLaw = new Map();
  try {
    const rows = await select<{ evidence_version_id: number; case_basis: string | null }>(getPool(),
      `SELECT v.evidence_version_id, ev.case_basis
         FROM v_evidence_in_force v JOIN evidence_version ev ON ev.evidence_version_id = v.evidence_version_id
        WHERE v.kv_id = ? AND v.source_type = 'ftc_case' AND ev.case_basis IS NOT NULL`, [idx.kvId]);
    for (const r of rows) {
      const keys = [...new Set(explicitRefs(r.case_basis ?? '').map((x) => (x.article ? `${x.law}|${artKey(x.article)}` : null))
        .filter((k): k is string => !!k && idx.lawByArticle.has(k)))];
      if (keys.length) idx.caseLaw.set(r.evidence_version_id, keys);
    }
  } catch (e) {
    logger.warn({ kvId: idx.kvId, err: (e as Error).message }, 'case basis unavailable');
  }
}

/** 벡터가 덜 채워진 인덱스는 이 간격마다 벡터만 다시 읽는다(임베딩 적재가 서버 실행 중에 끝나는 경우) */
const VEC_RELOAD_MS = 60_000;

/** VECTOR 컬럼(float32 LE 바이너리) → Float32Array. 버퍼 정렬을 보장하려고 복사한다 */
function toF32(b: Buffer | Uint8Array): Float32Array {
  const u = new Uint8Array(b.byteLength);
  u.set(b);
  return new Float32Array(u.buffer);
}

/** 벡터 적재(2026-09-30 비용 절감): ① 모델별 개수만(벡터 전송 없음) → 이미 다 있으면 끝 ② 로컬 캐시(근거 내용 해시 일치분)
 *  ③ 빠진 id 의 벡터만 DB 에서(그 모델만, 500개씩) ④ 새로 받은 것이 있으면 캐시 갱신. 다시 읽을 때도 같은 순서라 늘어난 것만 받는다 */
async function loadVectors(idx: Index): Promise<void> {
  idx.vecLoadedAt = Date.now();
  if (env.RAG_HYBRID !== 'on') return;
  try {
    const counts = await select<{ model: string; n: number }>(getPool(),
      `SELECT e.model, COUNT(*) AS n
         FROM evidence_embedding e
         JOIN v_evidence_in_force v ON v.evidence_version_id = e.evidence_version_id
        WHERE v.kv_id = ?
        GROUP BY e.model`, [idx.kvId]);
    // 모델이 둘 이상이면 가장 많이 채워진 것 하나(섞지 않는다)
    const top = [...counts].sort((a, b) => b.n - a.n || a.model.localeCompare(b.model))[0];
    if (!top) { idx.vecModel = null; idx.vec = new Map(); return; }
    if (top.model !== idx.vecModel) { idx.vecModel = top.model; idx.vec = new Map(); }
    if (idx.vec.size >= top.n) return;
    const model = top.model;
    const hashOf = new Map(idx.docs.map((d) => [d.row.evidence_version_id, evidenceTextHash(d.row)]));
    const useCache = vectorCacheEnabled();
    const cache = useCache ? readVectorCache(model) : null;
    let fromCache = 0;
    if (cache) {
      for (const [id, h] of hashOf) {
        const c = cache.get(id);
        if (!idx.vec.has(id) && c && c.h === h) { idx.vec.set(id, c.v); fromCache++; }
      }
    }
    const missing = [...hashOf.keys()].filter((id) => !idx.vec.has(id));
    const fresh = new Map<number, CachedVector>();
    for (let i = 0; i < missing.length && idx.vec.size < top.n; i += 500) {
      const part = missing.slice(i, i + 500);
      const rows = await select<{ evidence_version_id: number; embedding: Buffer }>(getPool(),
        `SELECT evidence_version_id, embedding FROM evidence_embedding
          WHERE model = ? AND evidence_version_id IN (${part.map(() => '?').join(',')})`, [model, ...part]);
      for (const r of rows) {
        const v = toF32(r.embedding);
        idx.vec.set(r.evidence_version_id, v);
        fresh.set(r.evidence_version_id, { v, h: hashOf.get(r.evidence_version_id)! });
      }
    }
    if (useCache && fresh.size) {
      // 다른 기준일 항목도 남긴다(버전은 불변). 해시가 바뀐 항목은 새 값으로 덮는다
      const merged = new Map(cache ?? []);
      for (const [id, c] of fresh) merged.set(id, c);
      writeVectorCache(model, merged);
    }
    logger.info({ kvId: idx.kvId, model, total: top.n, fromCache, fetched: fresh.size }, 'evidence vectors loaded');
  } catch (e) {
    // 006 미적용 DB 등 — BM25 만으로 동작
    logger.warn({ kvId: idx.kvId, err: (e as Error).message }, 'evidence vectors unavailable');
  }
}

const indexes = new Map<number, Promise<Index>>();

async function buildIndex(kvId: KvId): Promise<Index> {
  const rows = await evidenceInForce(kvId);
  const docs: Doc[] = rows.map((row) => {
    const toks = tokenize(`${row.source_name} ${row.identifier} ${row.excerpt}`);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { row, tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);
  const idx: Index = { kvId, docs, df, avgLen, vec: new Map(), vecModel: null, vecLoadedAt: 0, caseLaw: new Map(), lawByArticle: new Map() };
  await loadVectors(idx);
  await loadCaseLaw(idx);
  return idx;
}

/** 기준일은 불변이므로 무효화 없이 캐시한다(새 기준일은 새 키) */
export function indexFor(kvId: KvId): Promise<Index> {
  let p = indexes.get(kvId);
  if (!p) {
    p = buildIndex(kvId);
    indexes.set(kvId, p);
    p.catch(() => indexes.delete(kvId));
  }
  return p;
}

export function clearSearchIndex(kvId?: number): void {
  if (kvId === undefined) indexes.clear();
  else indexes.delete(kvId);
}

/** P0 0.4 승인 직후 새 기준일의 인덱스를 추가로 만든다(T132). 이전 기준일 인덱스는 진행 중 분석이 계속 쓴다(FR-039) */
export async function buildIndexForNewKv(kvId: KvId): Promise<number> {
  indexes.delete(kvId);
  return (await indexFor(kvId)).docs.length;
}

export interface ExplicitRef {
  law: string;
  article: string | null;
}

/** 조항 안의 명시 참조("약관법 제6조", "전자상거래법 시행령 제21조의2") 해석(FR-023) */
export function explicitRefs(text: string): ExplicitRef[] {
  const out: ExplicitRef[] = [];
  for (const [re, law] of LAW_ALIASES) {
    const g = new RegExp(re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      const sub = /^\s*(시행령|시행규칙)?\s*(제\s*\d+\s*조(?:의\s*\d+)?(?:\s*제\s*\d+\s*항)?)?/.exec(after);
      const lawName = sub?.[1] ? `${law} ${sub[1]}` : law;
      const article = sub?.[2] ? sub[2].replace(/\s+/g, '').replace(/조제/, '조 제') : null;
      out.push({ law: lawName, article });
    }
  }
  return out;
}

export interface SearchHints {
  riskType?: RiskType | null;
  relatedLaws?: string[];
  /** 평가 모드 전용 — 참이면 후보에서 뺀다(예: 평가 조항과 같은 공정위 사건). 서비스 분석에서는 쓰지 않는다 */
  exclude?: (row: EvidenceRow) => boolean;
  /** false 면 이번 검색은 BM25 만 */
  hybrid?: boolean;
  /** 평가·실험용 덮어쓰기(기본값 = env) */
  tuning?: Partial<SearchTuning>;
}

export interface SearchTuning {
  bm25Weight: number;
  denseWeight: number;
  /** 상위 유사 공정위 사례의 근거 법조로 법령 가산 */
  caseExpand: boolean;
  caseExpandTop: number;
  expandWeight: number;
  /** 'vote' = 상위 사례들의 근거 조문을 사례 순위 가중으로 투표해 조문 순위를 만든 뒤 그 순위로 가산(쟁점 추정 근사, 추가 호출 없음)
   *  'rank' = 사례마다 따로 가산(2026-09-30 첫 판) */
  caseExpandMode: 'vote' | 'rank';
  /** 결과에서 같은 조(법령명·제N조)의 법령 근거 최대 개수 — 같은 조의 여러 항이 자리를 차지하지 않게 */
  perArticleMax: number;
  /** 결과에 법령 근거 최소 개수(후보가 있을 때) */
  minLaw: number;
  topK: number;
  maxPerSource: number;
}

export function defaultTuning(): SearchTuning {
  // 사례 상위 20건(평가 2026-09-30: 5→10→15→20 에서 구체 조문 R@3 0.598→0.680→0.714→0.736)
  return { bm25Weight: 1, denseWeight: env.RAG_DENSE_WEIGHT, caseExpand: env.RAG_CASE_EXPAND === 'on',
    caseExpandTop: env.RAG_CASE_EXPAND_TOP, expandWeight: 1, minLaw: env.RAG_MIN_LAW,
    topK: TOP_K, maxPerSource: MAX_PER_SOURCE, caseExpandMode: env.RAG_CASE_EXPAND_MODE, perArticleMax: env.RAG_PER_ARTICLE_MAX };
}

export interface SearchHit {
  row: EvidenceRow;
  /** BM25 점수(기존 의미 유지 — 영향 식별이 score > 0 을 관련도로 쓴다) */
  score: number;
  explicit: boolean;
  /** 코사인 유사도(하이브리드일 때) */
  dense?: number | null;
  /** RRF 합산 점수(하이브리드일 때) */
  rrf?: number;
  /** 사례 근거 법조 확장으로 더해진 점수(하이브리드일 때) */
  expanded?: number;
}

const RRF_K = 60;
const CAND_K = 30;
const qvCache = new Map<string, { model: string; v: Float32Array }>();
const QV_CACHE_MAX = 500;

/** 조항 임베딩(게이트웨이 /v1/embed). 같은 비식별 조항은 캐시. 실패하면 null → BM25 만 */
async function queryVector(text: string, model: string): Promise<Float32Array | null> {
  const key = createHash('sha256').update(text).digest('hex');
  const hit = qvCache.get(key);
  if (hit && hit.model === model) return hit.v;
  try {
    const r = await modelApi.embed([text.slice(0, 8000)]);
    if (r.model_version !== model) {
      logger.warn({ indexModel: model, queryModel: r.model_version }, 'embedding model mismatch — BM25 only');
      return null;
    }
    const v = Float32Array.from(r.embeddings[0]!);
    if (qvCache.size >= QV_CACHE_MAX) qvCache.delete(qvCache.keys().next().value!);
    qvCache.set(key, { model, v });
    return v;
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'query embedding failed — BM25 only');
    return null;
  }
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/**
 * 판정 불가 관문 2(2026-09-30) — "계약 조항다움" 점수: 조항 벡터와 공정위 문제 조항·표준약관 조항 벡터의 유사도 상위 3 평균.
 * 조항들을 32개씩 한 번에 임베딩하고, 결과를 검색 캐시에도 넣어 이후 근거 검색이 다시 임베딩하지 않게 한다.
 * 벡터가 없거나 임베딩이 실패하면 null(= 관문 2 판단 보류, 판정 불가로 처리하지 않음).
 */
export async function clauseLikeness(kvId: KvId, texts: string[]): Promise<(number | null)[]> {
  const out: (number | null)[] = texts.map(() => null);
  if (env.RAG_HYBRID !== 'on' || !texts.length) return out;
  const idx = await indexFor(kvId);
  if (!idx.vecModel || !idx.vec.size) return out;
  const refs = idx.docs.filter((d) => d.row.source_type !== 'law_article').map((d) => idx.vec.get(d.row.evidence_version_id)).filter((v): v is Float32Array => !!v);
  if (!refs.length) return out;
  const vecs: (Float32Array | null)[] = texts.map((t) => {
    const hit = qvCache.get(createHash('sha256').update(t).digest('hex'));
    return hit && hit.model === idx.vecModel ? hit.v : null;
  });
  const todo = texts.map((t, i) => (vecs[i] ? -1 : i)).filter((i) => i >= 0);
  for (let k = 0; k < todo.length; k += 32) {
    const part = todo.slice(k, k + 32);
    try {
      const r = await modelApi.embed(part.map((i) => texts[i]!.slice(0, 8000)));
      if (r.model_version !== idx.vecModel) break;
      part.forEach((i, j) => {
        const v = Float32Array.from(r.embeddings[j]!);
        vecs[i] = v;
        if (qvCache.size >= QV_CACHE_MAX) qvCache.delete(qvCache.keys().next().value!);
        qvCache.set(createHash('sha256').update(texts[i]!).digest('hex'), { model: idx.vecModel!, v });
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'clause likeness embedding failed — gate 2 skipped');
      break;
    }
  }
  vecs.forEach((v, i) => {
    if (!v) return;
    const top = [-1, -1, -1];
    for (const r of refs) {
      const s = dot(v, r);
      if (s > top[2]!) { top[2] = s; top.sort((a, b) => b - a); }
    }
    out[i] = Math.round(((top[0]! + top[1]! + top[2]!) / 3) * 10000) / 10000;
  });
  return out;
}

const K1 = 1.2;
const B = 0.75;

export async function searchEvidence(kvId: KvId, clauseText: string, hints: SearchHints = {}): Promise<SearchHit[]> {
  const idx = await indexFor(kvId);
  if (env.RAG_HYBRID === 'on' && idx.vec.size < idx.docs.length && Date.now() - idx.vecLoadedAt > VEC_RELOAD_MS) await loadVectors(idx);
  const tu: SearchTuning = { ...defaultTuning(), ...(hints.tuning ?? {}) };
  const N = idx.docs.length;
  const qTokens = tokenize(clauseText);
  const hintTokens = hints.riskType ? tokenize(RISK_HINT_TERMS[hints.riskType]) : [];
  const qtf = new Map<string, number>();
  for (const t of qTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);
  for (const t of hintTokens) qtf.set(t, (qtf.get(t) ?? 0) + 0.5);
  const related = new Set(hints.relatedLaws ?? []);

  const refs = explicitRefs(clauseText);
  const isExplicit = (row: EvidenceRow) =>
    refs.some((r) => row.source_name === r.law && (r.article === null ? false : row.identifier.replace(/\s+/g, '').startsWith(r.article.replace(/\s+/g, ''))));

  const docs = hints.exclude ? idx.docs.filter((d) => !hints.exclude!(d.row)) : idx.docs;
  const scored: SearchHit[] = docs.map((d) => {
    let s = 0;
    for (const [t, w] of qtf) {
      const f = d.tf.get(t);
      if (!f) continue;
      const df = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      s += w * idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / idx.avgLen)));
    }
    if (related.size && (related.has(d.row.source_name) || [...related].some((l) => d.row.source_name.startsWith(l)))) s *= 1.3;
    return { row: d.row, score: Math.round(s * 10000) / 10000, explicit: isExplicit(d.row) };
  });

  // 하이브리드: 벡터가 있고 조항 임베딩이 되면 (가중) RRF → 사례 근거 법조 확장 → 법령 최소 개수
  const qv = hints.hybrid !== false && env.RAG_HYBRID === 'on' && idx.vecModel && idx.vec.size ? await queryVector(clauseText, idx.vecModel) : null;
  const byId = (a: SearchHit, b: SearchHit) => a.row.evidence_version_id - b.row.evidence_version_id;
  if (qv) {
    const bmRank = new Map<number, number>();
    [...scored].filter((h) => h.score > 0).sort((a, b) => b.score - a.score || byId(a, b)).slice(0, CAND_K)
      .forEach((h, i) => bmRank.set(h.row.evidence_version_id, i + 1));
    for (const h of scored) {
      const v = idx.vec.get(h.row.evidence_version_id);
      h.dense = v ? Math.round(dot(qv, v) * 10000) / 10000 : null;
    }
    const dnRank = new Map<number, number>();
    [...scored].filter((h) => h.dense != null).sort((a, b) => b.dense! - a.dense! || byId(a, b)).slice(0, CAND_K)
      .forEach((h, i) => dnRank.set(h.row.evidence_version_id, i + 1));
    for (const h of scored) {
      const a = bmRank.get(h.row.evidence_version_id);
      const b = dnRank.get(h.row.evidence_version_id);
      h.rrf = (a ? tu.bm25Weight / (RRF_K + a) : 0) + (b ? tu.denseWeight / (RRF_K + b) : 0);
    }
    if (tu.caseExpand) {
      // 상위 유사 사례(사례끼리 순위)의 근거 법조 → 그 조의 법령 근거에 사례 순위만큼 가산. 제외된 사례는 이미 후보에 없다
      const byEv = new Map(scored.map((h) => [h.row.evidence_version_id, h]));
      const cases = scored.filter((h) => h.row.source_type === 'ftc_case' && (h.rrf ?? 0) > 0)
        .sort((a, b) => b.rrf! - a.rrf! || byId(a, b)).slice(0, tu.caseExpandTop);
      const lawDocs = (k: string) => (idx.lawByArticle.get(k) ?? []).map((id) => byEv.get(id)).filter((h): h is SearchHit => !!h);
      const add = (h: SearchHit, v: number) => { h.expanded = (h.expanded ?? 0) + v; h.rrf = (h.rrf ?? 0) + v; };
      if (tu.caseExpandMode === 'vote') {
        // 사례 순위 가중 투표 → 조문 순위 → 조문 순위만큼 그 조의 법령 근거에 가산
        const votes = new Map<string, number>();
        cases.forEach((c, i) => { for (const k of idx.caseLaw.get(c.row.evidence_version_id) ?? []) votes.set(k, (votes.get(k) ?? 0) + 1 / (RRF_K + i + 1)); });
        [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .forEach(([k], r) => { for (const h of lawDocs(k)) add(h, tu.expandWeight / (RRF_K + r + 1)); });
      } else {
        cases.forEach((c, i) => { for (const k of idx.caseLaw.get(c.row.evidence_version_id) ?? []) for (const h of lawDocs(k)) add(h, tu.expandWeight / (RRF_K + i + 1)); });
      }
    }
    for (const h of scored) h.rrf = Math.round((h.rrf ?? 0) * 1e6) / 1e6;
    scored.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.rrf! - a.rrf! || byId(a, b));
  } else {
    scored.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.score - a.score || byId(a, b));
  }

  const alive = (h: SearchHit) => h.explicit || (qv ? (h.rrf ?? 0) > 0 : h.score > 0);
  const lawKey = (h: SearchHit) => (h.row.source_type === 'law_article' ? `${h.row.source_name}|${artKey(h.row.identifier) ?? h.row.identifier}` : null);
  const perArticle = new Map<string, number>();
  const articleFull = (h: SearchHit) => { const k = lawKey(h); return !!k && !h.explicit && !!qv && (perArticle.get(k) ?? 0) >= tu.perArticleMax; };
  const takeArticle = (h: SearchHit) => { const k = lawKey(h); if (k) perArticle.set(k, (perArticle.get(k) ?? 0) + 1); };
  const perSource = new Map<SourceType, number>();
  const out: SearchHit[] = [];
  for (const h of scored) {
    if (out.length >= tu.topK) break;
    if (!alive(h) || articleFull(h)) continue;
    const n = perSource.get(h.row.source_type) ?? 0;
    if (n >= tu.maxPerSource && !h.explicit) continue;
    perSource.set(h.row.source_type, n + 1);
    takeArticle(h);
    out.push(h);
  }
  // 법령 최소 개수: 부족하면 가장 낮은 순위의 비법령(명시 참조 제외)을 가장 높은 순위의 남은 법령 후보로 바꾼다(하이브리드만)
  if (qv && tu.minLaw > 0) {
    const lawIn = () => out.filter((h) => h.row.source_type === 'law_article').length;
    const spare = scored.filter((h) => h.row.source_type === 'law_article' && alive(h) && !out.includes(h));
    while (lawIn() < Math.min(tu.minLaw, tu.topK) && spare.length) {
      const law = spare.shift()!;
      if (articleFull(law)) continue;
      const victim = [...out].reverse().find((h) => h.row.source_type !== 'law_article' && !h.explicit);
      takeArticle(law);
      if (victim) out.splice(out.indexOf(victim), 1, law);
      else if (out.length < tu.topK) out.push(law);
      else break;
    }
    out.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.rrf! - a.rrf! || byId(a, b));
  }
  return out;
}
