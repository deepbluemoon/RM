// 이용자별 API 키(migration 007, 2026-09-30). 사용자는 API 활용 화면에서 키를 발급받아 외부 프로그램에서
// /api/model/… 로 모델 API 를 부른다. 백엔드가 키를 확인한 뒤 서버 키(MODEL_API_KEY)로 모델 서버에 넘긴다 — 서버 키는 밖으로 나가지 않는다.
// 원문 키는 발급 응답에 한 번만 싣고 저장하지 않는다(sha256 해시 + 앞 8자만 저장). 키·본문은 로그에 쓰지 않는다.
import crypto from 'node:crypto';
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { HttpError } from '../../middleware/errorHandler.js';

export const MAX_ACTIVE_KEYS = 5;
const PREFIX = 'crd_';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface ApiKeyView {
  keyId: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface AdminApiKeyView extends ApiKeyView {
  userId: number;
  ownerName: string | null;
  ownerLoginId: string | null;
}

type Row = { key_id: number; name: string; key_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const view = (r: Row): ApiKeyView => ({
  keyId: r.key_id, name: r.name, keyPrefix: r.key_prefix, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at),
});

export async function listMyKeys(userId: number): Promise<ApiKeyView[]> {
  const rows = await select<Row>(getPool(), 'SELECT key_id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_key WHERE user_id = ? ORDER BY key_id DESC', [userId]);
  return rows.map(view);
}

export async function listAllKeys(): Promise<AdminApiKeyView[]> {
  const rows = await select<Row & { user_id: number; display_name: string | null; login_id: string | null }>(
    getPool(),
    `SELECT k.key_id, k.name, k.key_prefix, k.created_at, k.last_used_at, k.revoked_at, k.user_id, p.display_name, p.login_id
       FROM api_key k LEFT JOIN auth_password p ON p.user_id = k.user_id
      ORDER BY k.revoked_at IS NOT NULL, k.key_id DESC`,
  );
  return rows.map((r) => ({ ...view(r), userId: r.user_id, ownerName: r.display_name, ownerLoginId: r.login_id }));
}

/** 새 키 발급 — 원문은 이 응답에서만 보인다 */
export async function issueKey(userId: number, nameRaw: unknown): Promise<ApiKeyView & { key: string }> {
  const name = (typeof nameRaw === 'string' ? nameRaw.trim() : '').slice(0, 40) || '이름 없는 키';
  const active = await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM api_key WHERE user_id = ? AND revoked_at IS NULL', [userId]);
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new HttpError(409, 'api_key_limit', `사용 중인 키는 ${MAX_ACTIVE_KEYS}개까지입니다. 쓰지 않는 키를 먼저 폐기해 주세요`);
  }
  const key = PREFIX + crypto.randomBytes(24).toString('base64url');
  const keyPrefix = key.slice(0, PREFIX.length + 8);
  const r = await exec(getPool(), 'INSERT INTO api_key (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)', [userId, name, keyPrefix, sha256(key)]);
  const row = await selectOne<Row>(getPool(), 'SELECT key_id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_key WHERE key_id = ?', [r.insertId]);
  return { ...view(row!), key };
}

/** 폐기 — 본인 키, 또는 운영자(asAdmin)는 누구의 키든 */
export async function revokeKey(keyId: number, byUserId: number, asAdmin: boolean): Promise<boolean> {
  const r = await exec(
    getPool(),
    `UPDATE api_key SET revoked_at = CURRENT_TIMESTAMP, revoked_by = ? WHERE key_id = ? AND revoked_at IS NULL${asAdmin ? '' : ' AND user_id = ?'}`,
    asAdmin ? [byUserId, keyId] : [byUserId, keyId, byUserId],
  );
  return r.affectedRows > 0;
}

/** Authorization: Bearer <키> 확인. 맞으면 키 주인, 아니면 null. 마지막 사용 시각은 1분 단위로만 갱신 */
export async function verifyBearer(authorization: string | undefined): Promise<{ keyId: number; userId: number } | null> {
  const m = /^Bearer\s+(crd_[A-Za-z0-9_-]{20,64})\s*$/.exec(authorization ?? '');
  if (!m) return null;
  const row = await selectOne<{ key_id: number; user_id: number }>(
    getPool(),
    'SELECT key_id, user_id FROM api_key WHERE key_hash = ? AND revoked_at IS NULL',
    [sha256(m[1]!)],
  );
  if (!row) return null;
  void exec(
    getPool(),
    'UPDATE api_key SET last_used_at = CURRENT_TIMESTAMP WHERE key_id = ? AND (last_used_at IS NULL OR last_used_at < CURRENT_TIMESTAMP - INTERVAL 1 MINUTE)',
    [row.key_id],
  ).catch(() => undefined);
  return { keyId: row.key_id, userId: row.user_id };
}
