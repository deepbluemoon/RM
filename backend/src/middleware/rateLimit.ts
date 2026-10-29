// 요청률 제한(T146): 로그인·회원가입·업로드·URL 수집·피드백·외부 모델 API·키 발급 경로
import type { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

export function rateLimits(api: Router): void {
  if (env.NODE_ENV === 'test') return;
  const mk = (windowMin: number, max: number) =>
    rateLimit({ windowMs: windowMin * 60_000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, message: { code: 'rate_limited', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요' } });
  api.use('/auth/login', mk(10, 20));
  api.use('/auth/signup', mk(60, 10));
  api.use('/auth', mk(10, 60));
  api.use('/model', mk(1, 60));
  api.use('/api-keys', mk(10, 60));
  api.use('/intake/uploads', mk(10, 30));
  api.use('/intake/url-fetches', mk(10, 30));
  api.use('/feedback', mk(10, 60));
}
