// 카카오 로그인 — authorization code 흐름. 동의 항목은 닉네임(profile_nickname)만 요청한다
import { env } from '../../../config/env.js';
import { fetchJson, type OAuthProvider } from './types.js';

export const kakao: OAuthProvider = {
  id: 'kakao',
  enabled: () => Boolean(env.KAKAO_CLIENT_ID),
  authorizeUrl(state, redirectUri) {
    const q = new URLSearchParams({ client_id: env.KAKAO_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code', state, scope: 'profile_nickname' });
    return `https://kauth.kakao.com/oauth/authorize?${q}`;
  },
  async exchange(code, _state, redirectUri) {
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: env.KAKAO_CLIENT_ID, redirect_uri: redirectUri, code });
    if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
    const tok = await fetchJson('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    const accessToken = String(tok.access_token ?? '');
    if (!accessToken) throw new Error('oauth_no_token');
    const me = await fetchJson('https://kapi.kakao.com/v2/user/me', { headers: { Authorization: `Bearer ${accessToken}` } });
    const account = (me.kakao_account ?? {}) as { profile?: { nickname?: string } };
    const props = (me.properties ?? {}) as { nickname?: string };
    return { subject: String(me.id), nickname: account.profile?.nickname ?? props.nickname ?? null };
  },
};
