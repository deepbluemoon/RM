// P9 9.7 OpenAPI 문서(T140, UC10 A1). 결정: 백엔드 프록시 — 모델 서버(FastAPI)의 /openapi.json 을 백엔드가 Bearer 키로 받아
// 그대로 돌려준다(키는 요청 헤더에만 쓰고 응답에는 싣지 않는다 — BR-API-02). 모델 서버가 문서를 제공하지 않으면(404)
// 계약 원본 specs/…/contracts/model-api.openapi.yaml 을 대신 준다(source=contract). 연결 불가·5xx·401 은 502.
// 60초 캐시 — 문서를 열 때마다 모델 서버를 부르지 않는다
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../../config/env.js';
import { modelApi, ModelApiError } from '../modelApi/client.js';

export const CONTRACT_PATH = path.join(REPO_ROOT, 'specs', '002-contract-risk-detection', 'contracts', 'model-api.openapi.yaml');
const TTL_MS = 60_000;

export type OpenapiResult =
  | { ok: true; source: 'model-server' | 'contract'; doc: unknown; yamlText?: undefined }
  | { ok: true; source: 'contract'; doc: null; yamlText: string }
  | { ok: false; status: 502; code: string; message: string; httpStatus: number | null };

let cache: { at: number; value: OpenapiResult } | null = null;

export function resetOpenapiCache(): void {
  cache = null;
}

async function fromContract(): Promise<OpenapiResult> {
  const text = await fs.readFile(CONTRACT_PATH, 'utf8');
  try {
    // yaml 은 개발 의존성 — 배포본에 없으면 YAML 원문을 그대로 준다
    const { parse } = (await import('yaml')) as { parse: (s: string) => unknown };
    return { ok: true, source: 'contract', doc: parse(text) };
  } catch {
    return { ok: true, source: 'contract', doc: null, yamlText: text };
  }
}

export async function modelOpenapi(refresh = false): Promise<OpenapiResult> {
  if (!refresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: OpenapiResult;
  try {
    value = { ok: true, source: 'model-server', doc: await modelApi.openapi() };
  } catch (e) {
    const err = e as ModelApiError;
    if (err instanceof ModelApiError && err.kind === 'not_found') {
      try {
        value = await fromContract();
      } catch {
        value = { ok: false, status: 502, code: 'openapi_unavailable', message: '모델 서버와 계약 파일 모두에서 OpenAPI 문서를 찾지 못했습니다', httpStatus: 404 };
      }
    } else {
      const auth = err instanceof ModelApiError && err.kind === 'auth';
      value = {
        ok: false,
        status: 502,
        code: auth ? 'model_api_auth_mismatch' : 'model_server_unreachable',
        message: auth ? 'API 키 불일치 - 백엔드 환경변수를 확인하세요' : '모델 API 서버에 연결할 수 없습니다',
        httpStatus: err instanceof ModelApiError ? err.httpStatus : null,
      };
    }
  }
  // 실패는 캐시하지 않는다 — 복구 후 바로 다시 열 수 있게
  if (value.ok) cache = { at: Date.now(), value };
  return value;
}

/** https://p2.sumzip.com/docs(FastAPI Swagger, Vite 프록시)용 — Try it out 이 서비스 주소(/api/model)로 가도록
 *  servers 를 바꾸고 Bearer Authorize 를 붙인다. 키는 넣지 않는다(사용자가 발급받은 키를 Authorize 에 입력). 캐시 원본은 바꾸지 않는다 */
export function forDocsPage(doc: unknown): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  const d = structuredClone(doc) as Record<string, any>;
  d.servers = [{ url: '/api/model', description: '서비스 주소 — Authorize 에 발급받은 API 키(crd_…)를 넣으세요' }];
  d.components = { ...(d.components ?? {}), securitySchemes: { ...(d.components?.securitySchemes ?? {}), bearer: { type: 'http', scheme: 'bearer' } } };
  d.security = [{ bearer: [] }];
  return d;
}
