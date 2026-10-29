// 게이트 차단 오류(T022). 게이트 응답은 이 모듈로만 만든다(CLAUDE.md). 문구 = SD_02 §14-2(messages.ts)
import { fill, GATE_MESSAGES, type GateCode, type NextAction, type ReleaseActor } from './messages.js';

/** HTTP 상태 사상 — SD_01 §14-2 / web-api 계약. 호출 지점이 계약상 다른 코드를 쓰면 status 로 덮어쓴다 */
export const GATE_HTTP_STATUS: Record<GateCode, number> = {
  G0: 409, G1: 200, G2: 422, G3: 422, G4: 429, G5: 503, G6: 422, G7: 409,
  G8: 403, G9: 200, G10: 409, G11: 409, G12: 409, G13: 200, G14: 403,
};

export interface GateOptions {
  params?: Record<string, string | number | undefined>;
  detail?: Record<string, unknown>;
  status?: number;
  nextActions?: NextAction[];
  eventId?: number;
  /** 계약상 본문 최상위에 더 싣는 필드(예: G2 업로드의 checks) */
  extra?: Record<string, unknown>;
}

export interface GateErrorBody {
  gate: GateCode;
  title: string;
  reason: string;
  releaseActor: ReleaseActor;
  releaseText: string;
  nextActions: NextAction[];
  eventId?: number;
  detail?: Record<string, unknown>;
}

export class GateError extends Error {
  readonly status: number;
  readonly body: GateErrorBody;

  constructor(public readonly gate: GateCode, opts: GateOptions = {}) {
    const m = GATE_MESSAGES[gate];
    const p = opts.params ?? {};
    const title = m.titleTemplate && Object.keys(p).length ? fill(m.titleTemplate, p) : m.title;
    super(title);
    this.name = 'GateError';
    this.status = opts.status ?? GATE_HTTP_STATUS[gate];
    this.body = {
      gate,
      title,
      reason: fill(m.reasonTemplate, p),
      releaseActor: m.releaseActor,
      releaseText: fill(m.releaseText, p),
      nextActions: opts.nextActions ?? m.nextActions,
      ...(opts.eventId !== undefined ? { eventId: opts.eventId } : {}),
      ...(opts.detail ? { detail: opts.detail } : {}),
      ...(opts.extra ?? {}),
    };
  }
}

/** 200 응답 안의 부분 차단(openGates·gates[]) 표현 */
export interface OpenGate {
  gate: GateCode;
  title: string;
  reason?: string;
  scope: 'full' | 'partial';
  releaseActor: ReleaseActor;
  eventId?: number;
}

export function openGate(gate: GateCode, params: Record<string, string | number | undefined> = {}, eventId?: number): OpenGate {
  const m = GATE_MESSAGES[gate];
  return {
    gate,
    title: m.titleTemplate && Object.keys(params).length ? fill(m.titleTemplate, params) : m.title,
    reason: fill(m.reasonTemplate, params),
    scope: m.scope,
    releaseActor: m.releaseActor,
    ...(eventId !== undefined ? { eventId } : {}),
  };
}
