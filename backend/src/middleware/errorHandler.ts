// 오류 응답(T023). GateError → 계약 스키마 본문, DomainError → 409/422, 그 밖은 500(요청 ID 만)
import type { NextFunction, Request, Response } from 'express';
import { GateError } from '../modules/gates/GateError.js';
import { DomainError } from '../db/errors.js';
import { logger } from '../logger.js';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ code: 'not_found', message: '요청한 경로가 없습니다' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (err instanceof GateError) {
    res.status(err.status).json(err.body);
    return;
  }
  if (err instanceof DomainError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ code: err.code, message: err.message });
    return;
  }
  const e = err as { type?: string; status?: number; code?: string };
  if (e?.type === 'entity.too.large' || e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ code: 'too_large', message: '요청이 너무 큽니다' });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'bad_json', message: '요청 형식이 올바르지 않습니다' });
    return;
  }
  logger.error({ reqId: req.id, err: { name: (err as Error)?.name, message: (err as Error)?.message, stack: (err as Error)?.stack } }, 'unhandled');
  res.status(500).json({ code: 'internal', message: '서버 오류가 발생했습니다', requestId: req.id });
}
