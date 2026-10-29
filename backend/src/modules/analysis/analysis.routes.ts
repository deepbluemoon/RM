// GET /api/analyses/{id} · PUT …/documents/{documentId}/contract-type (2.6) · POST …/cancel (FR-035(b)) · POST …/runs/{runId}/save (3.9)
import { Router } from 'express';
import { z } from 'zod';
import { ah, assertOwner } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { withTx } from '../../db/tx.js';
import { getPool, selectOne } from '../../db/pool.js';
import { CONTRACT_TYPES } from '../../domain/codes.js';
import { enqueue, cancel as cancelJob } from '../../jobs/runner.js';
import { runDetection } from '../detection/detection.service.js';
import { saveRun } from '../results/results.service.js';
import { analysisStatus, isCancellable } from './status.service.js';
import { getRequest, latestRun } from './analysis.repo.js';

export const analysisRouter = Router();
const idParam = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '요청을 찾을 수 없습니다');
  return n;
};

analysisRouter.get(
  '/analyses/:requestId',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    await assertOwner(req, id);
    res.json(await analysisStatus(id));
  }),
);

analysisRouter.put(
  '/analyses/:requestId/documents/:documentId/contract-type',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    const docId = idParam(req.params.documentId);
    await assertOwner(req, id);
    const body = z.object({ contractType: z.enum(CONTRACT_TYPES) }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', '계약 유형이 올바르지 않습니다');
    const runId = await withTx(async (conn) => {
      const [[r]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT stage, fixed_kv_id FROM analysis_request WHERE request_id = ? FOR UPDATE', [id]);
      if (!r || r.stage !== 'awaiting_type') throw new HttpError(409, 'not_awaiting_type', r?.stage === 'stopped' ? '중단된 분석입니다' : '계약 유형을 확정할 수 있는 단계가 아닙니다');
      const [upd] = await conn.query<import('mysql2').ResultSetHeader>(
        'UPDATE document SET contract_type = ?, contract_type_confirmed_at = CURRENT_TIMESTAMP WHERE document_id = ? AND request_id = ? AND is_contract = TRUE',
        [body.data.contractType, docId, id],
      );
      if (upd.affectedRows === 0) throw new HttpError(409, 'document_not_found', '확정할 문서가 없습니다');
      const [[left]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT COUNT(*) AS n FROM document WHERE request_id = ? AND is_contract = TRUE AND contract_type IS NULL', [id]);
      if (Number(left!.n) > 0) return null;
      // 모든 문서가 확정되면 P3 분석 실행을 시작한다(3.1)
      await conn.query("UPDATE analysis_request SET stage = 'type_confirmed' WHERE request_id = ?", [id]);
      const [run] = await conn.query<import('mysql2').ResultSetHeader>("INSERT INTO analysis_run (request_id, run_kind, kv_id, stage) VALUES (?, 'analysis', ?, 'detecting')", [id, r.fixed_kv_id]);
      return run.insertId;
    });
    if (runId) enqueue(id, 'detection', (signal) => runDetection(runId, signal));
    res.json(await analysisStatus(id));
  }),
);

analysisRouter.post(
  '/analyses/:requestId/cancel',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    await assertOwner(req, id, '분석을 취소할');
    await withTx(async (conn) => {
      await conn.query('SELECT request_id FROM analysis_request WHERE request_id = ? FOR UPDATE', [id]);
      const r = (await getRequest(id, conn))!;
      const run = await latestRun(id, conn);
      if (!isCancellable(r, run)) throw new HttpError(409, 'not_cancellable', '이미 끝났거나 중단된 분석은 취소할 수 없습니다');
      await conn.query("UPDATE analysis_request SET stage = 'stopped' WHERE request_id = ?", [id]);
      if (run && ['detecting', 'searching', 'explaining'].includes(run.stage)) {
        await conn.query("UPDATE analysis_run SET stage = 'aborted' WHERE run_id = ?", [run.run_id]);
        await conn.query("UPDATE clause_assessment SET status = 'unanalyzable', unanalyzable_reason = 'server_down' WHERE run_id = ? AND status = 'pending'", [run.run_id]);
      }
      // 원본은 곧바로 삭제 대상이 된다
      await conn.query('UPDATE document SET raw_delete_due_at = CURRENT_TIMESTAMP WHERE request_id = ? AND raw_file_ref IS NOT NULL', [id]);
    });
    cancelJob(id);
    res.json({ requestId: id });
  }),
);

analysisRouter.post(
  '/analyses/:requestId/runs/:runId/save',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    const runId = idParam(req.params.runId);
    await assertOwner(req, id);
    const run = await selectOne<{ request_id: number }>(getPool(), 'SELECT request_id FROM analysis_run WHERE run_id = ?', [runId]);
    if (!run || run.request_id !== id) throw new HttpError(404, 'not_found', '실행을 찾을 수 없습니다');
    await saveRun(req, id, runId);
    res.json({ runId, resultUrl: `/results/${runId}` });
  }),
);
