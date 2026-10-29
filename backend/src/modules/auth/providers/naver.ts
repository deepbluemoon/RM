// 네이버 로그인 — authorization code 흐름. 제공 정보는 식별자·별명만 쓴다
import { env } from '../../../config/env.js';
import { fetchJson, type OAuthProvider } from './types.js';

export const naver: OAuthProvider = {
  id: 'naver',
  enabled: () => Boolean(env.NAVER_CLIENT_ID),
  authorizeUrl(state, redirectUri) {
    const q = new URLSearchParams({ response_type: 'code', client_id: env.NAVER_CLIENT_ID, redirect_uri: redirectUri, state });
    return `https://nid.naver.com/oauth2.0/authorize?${q}`;
  },
  async exchange(code, state) {
    const q = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.NAVER_CLIENT_ID, client_secret: env.NAVER_CLIENT_SECRET, code, state });
    const tok = await fetchJson(`https://nid.naver.com/oauth2.0/token?${q}`, { method: 'POST' });
    const accessToken = String(tok.access_token ?? '');
    if (!accessToken) throw new Error('oauth_no_token');
    const me = await fetchJson('https://openapi.naver.com/v1/nid/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    const r = (me.response ?? {}) as { id?: string; nickname?: string };
    if (!r.id) throw new Error('oauth_no_subject');
    return { subject: r.id, nickname: r.nickname ?? null };
  },
};
