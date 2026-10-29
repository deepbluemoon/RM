// URL 수집 결과 보관(US3 T102 가 채운다) — 수집 본문은 메모리에만 30분 둔다(원문 개인정보가 있을 수 있어 디스크에 쓰지 않음)
import crypto from 'node:crypto';

export interface UrlSource {
  deviceKey: string;
  sourceUrl: string;
  collectedAt: string;
  displayName: string;
  text: string;
  at: number;
}

const store = new Map<string, UrlSource>();
const TTL = 30 * 60 * 1000;

export function putUrlSource(s: Omit<UrlSource, 'at'>): string {
  for (const [k, v] of store) if (Date.now() - v.at > TTL) store.delete(k);
  const token = crypto.randomBytes(18).toString('base64url');
  store.set(token, { ...s, at: Date.now() });
  return token;
}

export function readUrlSource(token: string, deviceKey: string): UrlSource | null {
  const s = store.get(token);
  if (!s || s.deviceKey !== deviceKey || Date.now() - s.at > TTL) return null;
  store.delete(token);
  return s;
}
