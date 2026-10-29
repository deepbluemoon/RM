// pino 구조화 로그(T020, T109). 요청·응답 본문은 남기지 않는다(research R-16, FR-009).
// 비식별 직렬화기(T109): formatters.log 가 모든 문자열 필드에 deid 탐지기를 적용하고(logSafe),
// 메시지 문자열도 hooks.logMethod 에서 같은 방식으로 가린다. 모델 API 오류 본문은 로그에 싣지 않는다.
import pino from 'pino';
import { env } from './config/env.js';
import { maskForLog } from './modules/deid/deid.service.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'authorization',
  'cookie',
  'password',
  '*.password',
  'text',
  '*.text',
  '*.deid_text',
  'deid_text',
  'opinion',
  '*.opinion',
  'opinionDeid',
  '*.opinionDeid',
  'code',
  '*.code',
  'access_token',
  '*.access_token',
  'refresh_token',
  '*.refresh_token',
  'nickname',
  '*.nickname',
  'body',
  '*.body',
  // 모델 API·외부 호출 오류 본문(FR-009) — 응답 본문은 어떤 이름으로도 남기지 않는다
  'responseBody',
  '*.responseBody',
  'response',
  '*.response',
  'detail',
  '*.detail',
];

/** 오류 객체는 이름·메시지·스택만 남긴다(본문·응답 필드는 버림). 메시지·스택도 가린다 */
function scrubError(e: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e.name, message: maskForLog(e.message) };
  if (e.stack) out.stack = maskForLog(e.stack);
  const kind = (e as { kind?: unknown }).kind;
  const httpStatus = (e as { httpStatus?: unknown }).httpStatus;
  const endpoint = (e as { endpoint?: unknown }).endpoint;
  if (typeof kind === 'string') out.kind = kind;
  if (typeof httpStatus === 'number') out.httpStatus = httpStatus;
  if (typeof endpoint === 'string') out.endpoint = endpoint;
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && depth < 4) out.cause = scrubError(cause, depth + 1);
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskForLog(value);
  if (depth > 6) return typeof value === 'object' && value !== null ? '〔생략〕' : value;
  if (value instanceof Error) return scrubError(value, depth);
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `〔바이너리 ${value.length}B〕`;
    if (value instanceof Date) return value;
    // 클래스 인스턴스(pino-http 의 req·res 래퍼 등)는 건드리지 않는다 — formatters.log 는 serializers 보다 먼저 돌아서,
    // 여기서 복사하면 getter(statusCode 등)가 사라지고 요청마다 큰 객체를 순회한다. 이들은 serializers 가 안전한 필드만 남긴다
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, depth + 1);
    return out;
  }
  return value;
}

/** 출력 대상을 바꿀 수 있는 싱크 — 로거 인스턴스는 하나로 두고(pino-http 가 잡아 둔다) 목적지만 교체한다 */
let target: pino.DestinationStream = pino.destination(1);
const sink: pino.DestinationStream = { write: (s: string) => target.write(s) };

export function createLogger(dest: pino.DestinationStream = sink): pino.Logger {
  return pino(
    {
      level: env.NODE_ENV === 'test' ? (process.env.LOG_LEVEL ?? 'silent') : env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '〔가림〕' },
      formatters: {
        log: (obj) => scrub(obj) as Record<string, unknown>,
      },
      hooks: {
        // 메시지 인자(문자열)도 가린다 — formatters.log 는 msg 를 보지 않는다
        logMethod(args, method) {
          const masked = args.map((a) => (typeof a === 'string' ? maskForLog(a) : a)) as Parameters<typeof method>;
          return method.apply(this, masked);
        },
      },
      base: undefined,
    },
    dest,
  );
}

export const logger = createLogger();

/** 테스트에서 로그 출력을 가로챈다(us4-pii-scan). level 을 주면 그 수준으로 바꾼다 */
export function setLoggerDestination(dest: pino.DestinationStream, level?: pino.LevelWithSilent): void {
  target = dest;
  if (level) logger.level = level;
}
