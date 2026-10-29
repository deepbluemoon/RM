// 소셜 로그인 계정 조회·생성·역할 부여(T025, RBAC). 자가 가입은 role=user 만(G14). 이메일 칸에는 합성 식별자를 넣는다(FR-043)
import crypto from 'node:crypto';
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { isDuplicate } from '../../db/errors.js';
import type { Role } from '../../domain/codes.js';
import type { ProviderId } from './providers/types.js';

export const syntheticEmail = (provider: ProviderId | 'local', subject: string): string =>
  `${provider}.${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 16)}@social.invalid`;

export interface AuthUser {
  userId: number;
  role: Role;
}

export async function findOrCreateUser(provider: ProviderId, subject: string): Promise<AuthUser> {
  const found = await selectOne<{ user_id: number; role: Role }>(
    getPool(),
    `SELECT u.user_id, u.role FROM auth_identity a JOIN app_user u ON u.user_id = a.user_id WHERE a.provider = ? AND a.provider_subject = ?`,
    [provider, subject],
  );
  if (found) {
    await exec(getPool(), 'UPDATE auth_identity SET last_login_at = CURRENT_TIMESTAMP WHERE provider = ? AND provider_subject = ?', [provider, subject]);
    return { userId: found.user_id, role: found.role };
  }
  try {
    return await withTx(async (conn) => {
      const [u] = await conn.query<import('mysql2').ResultSetHeader>('INSERT INTO app_user (email, role) VALUES (?, ?)', [syntheticEmail(provider, subject), 'user']);
      await conn.query('INSERT INTO auth_identity (provider, provider_subject, user_id, last_login_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)', [provider, subject, u.insertId]);
      return { userId: u.insertId, role: 'user' as Role };
    });
  } catch (e) {
    // 동시 첫 로그인 경합 — 다시 조회
    if (isDuplicate(e)) return findOrCreateUser(provider, subject);
    throw e;
  }
}

export async function grantRole(provider: ProviderId, subject: string, role: Role): Promise<boolean> {
  const res = await exec(
    getPool(),
    'UPDATE app_user u JOIN auth_identity a ON a.user_id = u.user_id SET u.role = ? WHERE a.provider = ? AND a.provider_subject = ?',
    [role, provider, subject],
  );
  return res.affectedRows > 0;
}

export async function grantRoleByUserId(userId: number, role: Role): Promise<boolean> {
  // 로그인 계정(auth_identity 가 있는 사용자)만 — 기록 없는 app_user 행에 역할을 주지 않는다
  const res = await exec(
    getPool(),
    'UPDATE app_user u SET u.role = ? WHERE u.user_id = ? AND EXISTS (SELECT 1 FROM auth_identity a WHERE a.user_id = u.user_id)',
    [role, userId],
  );
  return res.affectedRows > 0;
}

export async function listAccounts(): Promise<{ user_id: number; role: Role; provider: string; provider_subject: string; last_login_at: Date | null }[]> {
  return select(
    getPool(),
    `SELECT u.user_id, u.role, a.provider, a.provider_subject, a.last_login_at
       FROM auth_identity a JOIN app_user u ON u.user_id = a.user_id
      ORDER BY u.user_id`,
  );
}
