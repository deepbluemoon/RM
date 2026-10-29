// /api/auth/login · signup(아이디·비밀번호, 2026-09-30), /api/auth/{provider}/start · callback(소셜 — 화면에서는 숨김), /api/auth/logout, /api/session (T025, RBAC). state 쿠키로 CSRF 를 막고, 로그인 시 세션을 재발급한다
import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../../config/env.js';
import { ah } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../logger.js';
import { findOrCreateUser } from './auth.service.js';
import { createLocalAccount, loginLocal } from './password.service.js';
import type { Role } from '../../domain/codes.js';
import { permissionsOf } from './rbac.js';
import { kakao } from './providers/kakao.js';
import { naver } from './providers/naver.js';
import { dev } from './providers/dev.js';
import type { OAuthProvider, ProviderId } from './providers/types.js';

const PROVIDERS: Record<ProviderId, OAuthProvider> = { kakao, naver, dev };
const STATE_COOKIE = 'crd_oauth_state';

export const enabledProviders = (): ProviderId[] => (Object.keys(PROVIDERS) as ProviderId[]).filter((p) => PROVIDERS[p].enabled());

function provider(req: Request): OAuthProvider {
  const p = PROVIDERS[req.params.provider as ProviderId];
  if (!p || !p.enabled()) throw new HttpError(404, 'provider_disabled', '사용할 수 없는 로그인 방식입니다');
  return p;
}

/** OAuth redirect URI 화이트리스트 — OAUTH_REDIRECT_BASE 하나에서만 만든다(T146). dev 는 외부를 거치지 않으므로 같은 출처 상대 경로 */
const redirectUri = (p: ProviderId) =>
  p === 'dev' ? '/api/auth/dev/callback' : `${env.OAUTH_REDIRECT_BASE.replace(/\/$/, '')}/api/auth/${p}/callback`;

/** returnTo 는 앱 내부 경로만 허용한다(오픈 리다이렉트 방지) */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//') || v.includes('\\')) return '/';
  return v.slice(0, 300);
}

function readCookie(req: Request, name: string): string | undefined {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export const authRouter = Router();

/** 로그인 세션 만들기 — 세션 고정 공격 방지를 위해 세션 ID 를 새로 발급한다 */
async function startSession(req: Request, user: { userId: number; role: Role }, provider: 'kakao' | 'naver' | 'dev' | 'local', nickname: string | null): Promise<void> {
  await new Promise<void>((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.userId = user.userId;
  req.session.role = user.role;
  req.session.provider = provider;
  req.session.nickname = nickname;
  await new Promise<void>((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
}

/** 아이디·비밀번호 로그인(2026-09-30). 성공하면 세션을 만들고 세션 정보를 돌려준다 */
authRouter.post(
  '/auth/login',
  ah(async (req, res) => {
    const u = await loginLocal(req.body?.loginId, req.body?.password);
    await startSession(req, u, 'local', u.name);
    logger.info({ reqId: req.id, provider: 'local', userId: u.userId }, 'login');
    res.json({ ok: true, returnTo: safeReturnTo(req.body?.returnTo) });
  }),
);

/** 회원가입 — 사용자(user) 역할로 계정을 만들고 바로 로그인한다. 운영자 계정은 npm run admin:create-account 로만 */
authRouter.post(
  '/auth/signup',
  ah(async (req, res) => {
    const u = await createLocalAccount({ loginId: req.body?.loginId, password: req.body?.password, name: req.body?.name }, 'user');
    await startSession(req, u, 'local', u.name);
    logger.info({ reqId: req.id, provider: 'local', userId: u.userId }, 'signup');
    res.status(201).json({ ok: true, returnTo: safeReturnTo(req.body?.returnTo) });
  }),
);

authRouter.get(
  '/auth/:provider/start',
  ah(async (req, res) => {
    const p = provider(req);
    const state = crypto.randomBytes(24).toString('base64url');
    const returnTo = safeReturnTo(req.query.returnTo);
    res.cookie(STATE_COOKIE, `${state}.${Buffer.from(returnTo).toString('base64url')}`, {
      httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', maxAge: 10 * 60 * 1000, path: '/api/auth',
    });
    res.redirect(302, p.authorizeUrl(state, redirectUri(p.id), req));
  }),
);

authRouter.get(
  '/auth/:provider/callback',
  ah(async (req, res) => {
    const p = provider(req);
    const stored = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/api/auth' });
    const [state, rt] = (stored ?? '').split('.');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code || req.query.state !== state) throw new HttpError(400, 'invalid_state', '로그인 요청이 올바르지 않습니다. 다시 시도해 주세요');
    let profile;
    try {
      profile = await p.exchange(code, state, redirectUri(p.id));
    } catch (e) {
      logger.warn({ reqId: req.id, provider: p.id, err: (e as Error).message }, 'oauth exchange failed');
      throw new HttpError(400, 'oauth_failed', '로그인 제공자와 통신하지 못했습니다. 다시 시도해 주세요');
    }
    const user = await findOrCreateUser(p.id, profile.subject);
    const returnTo = safeReturnTo(rt ? Buffer.from(rt, 'base64url').toString() : '/');
    await startSession(req, user, p.id, profile.nickname);
    logger.info({ reqId: req.id, provider: p.id, userId: user.userId }, 'login');
    res.redirect(302, returnTo);
  }),
);

authRouter.post(
  '/auth/logout',
  ah(async (req, res) => {
    if (req.session) await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
    res.clearCookie('crd.sid');
    res.status(204).end();
  }),
);

/** 로그인 상태·역할·권한 — 화면 메뉴와 라우트 가드가 쓴다(권한 판정 원천은 서버 rbac.ts) */
authRouter.get('/session', (req, res) => {
  const a = req.auth;
  res.json({
    loggedIn: !!a,
    user: a ? { userId: a.userId, role: a.role, provider: req.session.provider ?? null, nickname: req.session.nickname ?? null } : null,
    permissions: a ? permissionsOf(a.role) : [],
    authProviders: enabledProviders(),
  });
});
