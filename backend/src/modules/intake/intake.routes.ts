// POST /api/intake/uploads (1.2·1.3, G2) · POST /api/intake/url-fetches (1.4, G3) · POST /api/analyses (1.5~1.7, G5)
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { ah } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { raise } from '../gates/gates.service.js';
import { policy } from '../../config/policy.js';
import { precheck } from './precheck.js';
import { saveUpload } from './rawStore.js';
import { createRequest } from './intake.service.js';
import { supportedFormats } from '../extract/index.js';
import { fetchTermsPage, UrlFetchError } from './urlFetch.js';
import { putUrlSource } from './urlSources.js';

/** multer·busboy 버전에 따라 파일명이 UTF-8 그대로 오거나 latin1 로 풀려 온다 — latin1 로 풀린 경우에만 되돌린다 */
export function utf8FileName(name: string): string {
  if (![...name].every((c) => c.charCodeAt(0) <= 0xff)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

export const intakeRouter = Router();
const MULTER_LIMIT = 55 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MULTER_LIMIT, files: 1 } });

intakeRouter.post(
  '/intake/uploads',
  ah(async (req, res) => {
    const subject = { userId: req.owner.userId, sessionId: null };
    await new Promise<void>((resolve, reject) =>
      upload.single('file')(req, res, (err: unknown) => {
        if (!err) return resolve();
        if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
          // 55MB 초과는 본문을 끝까지 받지 않고 G2 로 막는다(413)
          raise('G2', 'too_large', subject, {
            status: 413,
            params: { detail: `${policy('FILE_MAX_MB')}MB·${policy('FILE_MAX_PAGES')}쪽 한도 초과` },
            extra: { checks: [{ check: 'size', passed: false, message: `한도 ${policy('FILE_MAX_MB')}MB 초과` }] },
          }).catch(reject);
          return;
        }
        reject(err);
      }),
    );
    const file = req.file;
    if (!file) throw new HttpError(400, 'file_required', '파일을 선택해 주세요');
    const originalName = utf8FileName(file.originalname);
    const r = await precheck(file.buffer, originalName, supportedFormats());
    if (!r.ok) {
      await raise('G2', r.reasonCode ?? r.checks.find((c) => !c.passed)?.check ?? 'precheck_failed', subject, {
        status: 400,
        params: { detail: r.reason },
        extra: { checks: r.checks },
        detail: { checks: r.checks },
      });
    }
    const uploadToken = saveUpload(file.buffer, {
      deviceKey: req.owner.deviceKey!,
      userId: req.owner.userId,
      format: r.format!,
      pages: r.pages,
      sizeBytes: r.sizeBytes,
      originalName,
      createdAt: new Date().toISOString(),
    });
    res.status(201).json({ uploadToken, format: r.format, pages: r.pages, sizeBytes: r.sizeBytes, checks: r.checks });
  }),
);

const UrlBody = z.object({ url: z.string().trim().min(1).max(1000) });

// 약관 게시 페이지 본문 수집(FR-004) — 본문은 메모리에만 두고 토큰으로 넘긴다(urlSources). 실패는 G3(대안: 파일·텍스트)
intakeRouter.post(
  '/intake/url-fetches',
  ah(async (req, res) => {
    const body = UrlBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', 'URL 을 확인해 주세요');
    const subject = { userId: req.owner.userId, sessionId: null };
    let page: Awaited<ReturnType<typeof fetchTermsPage>>;
    try {
      page = await fetchTermsPage(body.data.url);
    } catch (e) {
      if (e instanceof UrlFetchError) await raise('G3', e.reason, subject, { params: { detail: e.detail } });
      throw e;
    }
    const sourceToken = putUrlSource({
      deviceKey: req.owner.deviceKey!,
      sourceUrl: page.sourceUrl,
      collectedAt: page.collectedAt,
      displayName: page.title || new URL(page.sourceUrl).hostname,
      text: page.text,
    });
    res.status(201).json({ sourceToken, sourceUrl: page.sourceUrl, collectedAt: page.collectedAt, charCount: page.text.length });
  }),
);

const AnalysisBody = z.object({
  perspective: z.enum(['consumer', 'business']),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), uploadToken: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('url'), sourceToken: z.string().min(1).max(64) }),
    z.object({ kind: z.literal('text'), text: z.string().min(1).max(2_000_000) }),
  ]),
});

intakeRouter.post(
  '/analyses',
  ah(async (req, res) => {
    const body = AnalysisBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', '요청 형식이 올바르지 않습니다');
    const r = await createRequest(req, res, body.data.perspective, body.data.source);
    res.status(201).json(r);
  }),
);
