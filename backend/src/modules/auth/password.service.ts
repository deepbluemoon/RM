// 아이디·비밀번호 로그인과 회원가입(migration 007, 2026-09-30). 자가 가입은 사용자(user) 역할만 — 운영자는 admin:create-account 로 만든다.
// 비밀번호는 scrypt 해시만 저장하고, 원문·해시·아이디를 로그에 쓰지 않는다. 계정이 없을 때도 같은 시간만큼 해시를 계산해 아이디 존재 여부가 드러나지 않게 한다.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { exec, getPool, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { isDuplicate } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { Role } from '../../domain/codes.js';
import { syntheticEmail } from './auth.service.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 16384, R = 8, P = 1, LEN = 32;

export const LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{3,31}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
export const NAME_MAX = 20;

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = await scrypt(pw, Buffer.from(salt, 'base64url'), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// 없는 아이디에도 같은 비용을 들이기 위한 고정 해시
const DUMMY = hashPassword('crd-dummy-password');

export const normalizeLoginId = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');

export interface SignupInput { loginId: unknown; password: unknown; name: unknown }
export interface LocalUser { userId: number; role: Role; name: string }

/** 입력 검사 — 틀리면 400(무엇이 틀렸는지 쉬운 말로) */
export function validateSignup(input: SignupInput): { loginId: string; password: string; name: string } {
  const loginId = normalizeLoginId(input.loginId);
  const password = typeof input.password === 'string' ? input.password : '';
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (!LOGIN_ID_RE.test(loginId)) throw new HttpError(400, 'invalid_login_id', '아이디는 영문 소문자·숫자로 시작하는 4~32자(영문·숫자·. _ -)로 정해 주세요');
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new HttpError(400, 'invalid_password', `비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자로 정해 주세요`);
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new HttpError(400, 'invalid_password', '비밀번호에는 영문과 숫자를 함께 넣어 주세요');
  if (!name || name.length > NAME_MAX) throw new HttpError(400, 'invalid_name', `이름은 1~${NAME_MAX}자로 적어 주세요`);
  return { loginId, password, name };
}

/** 계정 만들기. 회원가입은 role=user 만(운영자는 스크립트로) */
export async function createLocalAccount(input: SignupInput, role: Role = 'user'): Promise<LocalUser> {
  const v = validateSignup(input);
  const hash = await hashPassword(v.password);
  try {
    return await withTx(async (conn) => {
      const [u] = await conn.query<import('mysql2').ResultSetHeader>('INSERT INTO app_user (email, role) VALUES (?, ?)', [syntheticEmail('local', v.loginId), role]);
      await conn.query('INSERT INTO auth_identity (provider, provider_subject, user_id) VALUES (?, ?, ?)', ['local', v.loginId, u.insertId]);
      await conn.query('INSERT INTO auth_password (user_id, login_id, password_hash, display_name) VALUES (?, ?, ?, ?)', [u.insertId, v.loginId, hash, v.name]);
      return { userId: u.insertId, role, name: v.name };
    });
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, 'login_id_taken', '이미 쓰고 있는 아이디입니다. 다른 아이디를 정해 주세요');
    throw e;
  }
}

/** 아이디·비밀번호 확인. 틀리면 어느 쪽이 틀렸는지 알려 주지 않는다 */
export async function loginLocal(loginIdRaw: unknown, passwordRaw: unknown): Promise<LocalUser> {
  const loginId = normalizeLoginId(loginIdRaw);
  const password = typeof passwordRaw === 'string' ? passwordRaw : '';
  const row = loginId
    ? await selectOne<{ user_id: number; role: Role; password_hash: string; display_name: string }>(
        getPool(),
        'SELECT p.user_id, u.role, p.password_hash, p.display_name FROM auth_password p JOIN app_user u ON u.user_id = p.user_id WHERE p.login_id = ?',
        [loginId],
      )
    : null;
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), row?.password_hash ?? (await DUMMY));
  if (!row || !ok) throw new HttpError(401, 'login_failed', '아이디 또는 비밀번호가 맞지 않습니다');
  await exec(getPool(), "UPDATE auth_identity SET last_login_at = CURRENT_TIMESTAMP WHERE provider = 'local' AND provider_subject = ?", [loginId]);
  return { userId: row.user_id, role: row.role, name: row.display_name };
}

/** 비밀번호 바꾸기(스크립트용) */
export async function resetPassword(loginIdRaw: string, password: string): Promise<boolean> {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw new Error(`비밀번호는 ${PASSWORD_MIN}~${PASSWORD_MAX}자`);
  const r = await exec(getPool(), 'UPDATE auth_password SET password_hash = ? WHERE login_id = ?', [await hashPassword(password), normalizeLoginId(loginIdRaw)]);
  return r.affectedRows > 0;
}

/** 머리글에 보일 이름 — 아이디·비밀번호 계정은 가입 때 받은 이름 */
export async function displayNameOf(userId: number): Promise<string | null> {
  const r = await selectOne<{ display_name: string }>(getPool(), 'SELECT display_name FROM auth_password WHERE user_id = ?', [userId]);
  return r?.display_name ?? null;
}
