// 원본 파일 임시 보관(T065, research R-12): RAW_STORAGE_DIR 에 무작위 파일명으로 AES-256-GCM 암호화 저장.
// 파일 = iv(12) + tag(16) + ciphertext. 메타데이터(원래 파일명 포함)도 같은 방식으로 암호화해 옆에 둔다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT, env } from '../../config/env.js';

const dir = () => {
  const d = path.resolve(BACKEND_ROOT, env.RAW_STORAGE_DIR);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const key = () => Buffer.from(env.RAW_FILE_KEY, 'hex');

function encrypt(data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

function decrypt(blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export interface UploadMeta {
  deviceKey: string;
  userId: number | null;
  format: string;
  pages: number | null;
  sizeBytes: number;
  originalName: string;
  createdAt: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function saveUpload(data: Buffer, meta: UploadMeta): string {
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(path.join(dir(), `up-${token}.bin`), encrypt(data), { mode: 0o600 });
  fs.writeFileSync(path.join(dir(), `up-${token}.meta`), encrypt(Buffer.from(JSON.stringify(meta))), { mode: 0o600 });
  return token;
}

export function readUploadMeta(token: string): UploadMeta | null {
  if (!TOKEN_RE.test(token)) return null;
  const p = path.join(dir(), `up-${token}.meta`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(decrypt(fs.readFileSync(p)).toString('utf8')) as UploadMeta;
}

/** 업로드를 분석 요청 소유로 옮긴다 — 반환값이 document.raw_file_ref */
export function claimUpload(token: string, requestId: number): string {
  const ref = `req-${requestId}-${crypto.randomBytes(8).toString('hex')}.bin`;
  fs.renameSync(path.join(dir(), `up-${token}.bin`), path.join(dir(), ref));
  fs.rmSync(path.join(dir(), `up-${token}.meta`), { force: true });
  return ref;
}

export function readRaw(ref: string): Buffer {
  if (!/^req-\d+-[0-9a-f]{16}\.bin$/.test(ref)) throw new Error('invalid raw ref');
  return decrypt(fs.readFileSync(path.join(dir(), ref)));
}

export function deleteRaw(ref: string): void {
  if (!/^req-\d+-[0-9a-f]{16}\.bin$/.test(ref)) return;
  fs.rmSync(path.join(dir(), ref), { force: true });
}

/** 분석 요청을 만들지 않은 업로드 — maxAgeMs 보다 오래된 것 삭제(1시간, R-12 P-1) */
export function purgeStaleUploads(maxAgeMs = 3600_000): number {
  let n = 0;
  const now = Date.now();
  for (const f of fs.readdirSync(dir())) {
    if (!f.startsWith('up-')) continue;
    const p = path.join(dir(), f);
    if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
      fs.rmSync(p, { force: true });
      if (f.endsWith('.bin')) n++;
    }
  }
  return n;
}

export function rawExists(ref: string): boolean {
  return fs.existsSync(path.join(dir(), ref));
}
