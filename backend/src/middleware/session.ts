// 로그인 세션(T024): express-session + express-mysql-session → http_session 테이블(migration 002)
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import type { Role } from '../domain/codes.js';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    role?: Role;
    provider?: 'kakao' | 'naver' | 'dev' | 'local';
    /** 머리글에 보일 이름 — 아이디·비밀번호 계정은 가입 때 받은 이름(auth_password.display_name), 소셜은 세션에만 둔다 */
    nickname?: string | null;
    oauthState?: string;
    returnTo?: string;
  }
}

export const SESSION_COOKIE = 'crd.sid';

export function sessionMiddleware(): RequestHandler {
  const MySQLStore = MySQLStoreFactory(session as never);
  const store = new MySQLStore({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    createDatabaseTable: false,
    clearExpired: true,
    checkExpirationInterval: 15 * 60 * 1000,
    schema: { tableName: 'http_session', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } },
  });
  return session({
    name: SESSION_COOKIE,
    secret: env.SESSION_SECRET,
    store: store as unknown as session.Store,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    },
  });
}
