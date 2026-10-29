// 개발용 제공자 — AUTH_DEV_PROVIDER=true 이고 production 이 아닐 때만. 외부 호출 없이 곧바로 callback 으로 보낸다.
// ?devSubject= 로 여러 개발 계정을 흉내 낸다(역할은 admin:grant-role --provider dev 로 부여)
import { devAuthEnabled } from '../../../config/env.js';
import type { OAuthProvider } from './types.js';

export const dev: OAuthProvider = {
  id: 'dev',
  enabled: devAuthEnabled,
  authorizeUrl(state, redirectUri, req) {
    const raw = typeof req.query.devSubject === 'string' ? req.query.devSubject : 'dev-user';
    const subject = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'dev-user';
    const q = new URLSearchParams({ code: `dev:${subject}`, state });
    return `${redirectUri}?${q}`;
  },
  async exchange(code) {
    if (!code.startsWith('dev:')) throw new Error('oauth_bad_code');
    const subject = code.slice(4);
    return { subject, nickname: `개발자 ${subject}` };
  },
};
