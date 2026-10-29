// 계약 검증 도우미(T044): 두 OpenAPI 파일을 ajv 로 불러 응답 본문을 스키마로 검증한다
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv·ajv-formats 는 CJS 기본 내보내기 — ESM 에서 default 를 한 번 더 벗긴다
const Ajv = ((AjvModule as unknown as { default?: typeof AjvModule }).default ?? AjvModule) as unknown as typeof AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as typeof addFormatsModule.default;
type AjvInstance = InstanceType<typeof Ajv>;
import { fileURLToPath as __f2p } from 'node:url';
const __dirname = path.dirname(__f2p(import.meta.url));

const CONTRACTS = path.resolve(__dirname, '..', '..', '..', 'specs', '002-contract-risk-detection', 'contracts');

interface OpenApiDoc {
  paths: Record<string, Record<string, { responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: unknown }> }> }>>;
  components: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> };
}

/** OAS 3.0 의 `allOf + nullable`(type 없음)은 ajv 가 받지 않는다 — anyOf[원래 스키마, null] 로 바꿔 읽는다(계약 파일은 그대로) */
function normalizeNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeNullable);
  if (!node || typeof node !== 'object') return node;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) o[k] = normalizeNullable(v);
  if (o.nullable === true && o.type === undefined) {
    const { nullable: _n, description, ...rest } = o;
    return { ...(description ? { description } : {}), anyOf: [rest, { type: 'null' }] };
  }
  return o;
}

function load(file: string, id: string): { ajv: AjvInstance; doc: OpenApiDoc } {
  const doc = normalizeNullable(YAML.parse(fs.readFileSync(path.join(CONTRACTS, file), 'utf8'))) as OpenApiDoc & Record<string, unknown>;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: id });
  return { ajv, doc };
}

const specs = {
  web: load('web-api.openapi.yaml', 'web'),
  model: load('model-api.openapi.yaml', 'model'),
};
const cache = new Map<string, ValidateFunction>();

function schemaRef(spec: 'web' | 'model', p: string, method: string, status: number): string | null {
  const { doc } = specs[spec];
  const op = doc.paths[p]?.[method.toLowerCase()];
  if (!op) throw new Error(`계약에 없는 operation: ${method} ${p}`);
  const r = op.responses?.[String(status)];
  if (!r) throw new Error(`계약에 없는 응답 코드: ${method} ${p} ${status}`);
  const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
  if (r.$ref) {
    const name = r.$ref.split('/').pop()!;
    return doc.components.responses?.[name]?.content?.['application/json'] ? `${spec}#/components/responses/${name}/content/application~1json/schema` : null;
  }
  if (!r.content?.['application/json']?.schema) return null;
  return `${spec}#/paths/${esc(p)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
}

export function expectResponse(spec: 'web' | 'model', method: string, p: string, status: number, body: unknown): void {
  const ref = schemaRef(spec, p, method, status);
  if (!ref) return;
  let v = cache.get(ref);
  if (!v) {
    v = specs[spec].ajv.compile({ $ref: ref }) as ValidateFunction;
    cache.set(ref, v);
  }
  if (!v(body)) {
    throw new Error(`계약 불일치 ${method} ${p} ${status}: ${specs[spec].ajv.errorsText(v.errors)}\n${JSON.stringify(body).slice(0, 600)}`);
  }
}
