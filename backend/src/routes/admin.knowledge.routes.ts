// /api/admin/knowledge/* (US7 P0 T133, SD_02 §4 S0) — 운영자만(RBAC knowledge.manage, UC7)
import { Router } from 'express';
import { ah } from '../middleware/guards.js';
import { HttpError } from '../middleware/errorHandler.js';
import { batchDto, retryBatch, setItemInclude, startBatch, versionsDto } from '../modules/knowledge/ingest.service.js';
import { approveBatch } from '../modules/knowledge/approve.service.js';

export const adminKnowledgeRouter = Router();

const idParam = (v: string | undefined): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'bad_id', '잘못된 번호입니다');
  return n;
};

/** 지식 기준일 목록(활성·대체됨), 분석 기준 버전 */
adminKnowledgeRouter.get('/admin/knowledge/versions', ah(async (_req, res) => {
  res.json(await versionsDto());
}));

/** 0.1~0.3 갱신 개시 — 4개 기관 병렬 수집(비동기). 진행은 GET 으로 본다 */
adminKnowledgeRouter.post('/admin/knowledge/ingest-batches', ah(async (_req, res) => {
  res.status(202).json({ batchId: await startBatch() });
}));

/** 레일·기관별 수집 결과(G0)·반영 대상 판정 라벨·검토 목록(G1)·반영 경과일 */
adminKnowledgeRouter.get('/admin/knowledge/ingest-batches/:batchId', ah(async (req, res) => {
  res.json(await batchDto(idParam(req.params.batchId)));
}));

/** G0 해제 — 다시 수집 */
adminKnowledgeRouter.post('/admin/knowledge/ingest-batches/:batchId/retry', ah(async (req, res) => {
  const batchId = idParam(req.params.batchId);
  await retryBatch(batchId);
  res.status(202).json({ batchId });
}));

/** 항목 반영 포함 여부 — 분리 실패(G1)는 포함 불가(DB 거부 → 409 G1) */
adminKnowledgeRouter.patch('/admin/knowledge/ingest-batches/:batchId/items/:itemId', ah(async (req, res) => {
  const include = (req.body as { include?: unknown } | undefined)?.include;
  if (typeof include !== 'boolean') throw new HttpError(400, 'bad_request', 'include(true/false)가 필요합니다');
  res.json(await setItemInclude(idParam(req.params.batchId), idParam(req.params.itemId), include));
}));

/** 0.4 반영 승인(새 지식 기준일) → 0.5 영향 결과 → 0.6 반영 기한 */
adminKnowledgeRouter.post('/admin/knowledge/ingest-batches/:batchId/approve', ah(async (req, res) => {
  const basis = (req.body as { analysisBasisVersion?: unknown } | undefined)?.analysisBasisVersion;
  res.json(await approveBatch(idParam(req.params.batchId), {
    analysisBasisVersion: typeof basis === 'string' && basis.trim() ? basis.trim() : null,
    operatorUserId: req.owner.userId,
  }));
}));
