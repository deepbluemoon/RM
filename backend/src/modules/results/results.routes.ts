// GET /api/results/{runId} (4.1~4.3) · …/clauses/{assessmentId} (4.4·4.6) · …/rejudge (4.5) · GET /api/evidence/{id} (4.6·4.7)
import { Router } from 'express';
import { ah, assertOwner, assertRunOwner } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { getPool, select } from '../../db/pool.js';
import { evidenceVersion, toEvidenceDto } from '../evidence/evidence.repo.js';
import { assertSaved, clauseDetail, resultView } from './results.service.js';
import { rejudge } from './rejudge.service.js';
import { explanation } from './explanation.service.js';
import { comparison, similarCases } from './comparison.service.js';

export const resultsRouter = Router();
const num = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '찾을 수 없습니다');
  return n;
};

resultsRouter.get(
  '/results/:runId',
  ah(async (req, res) => {
    const runId = num(req.params.runId);
    await assertRunOwner(req, runId);
    await assertSaved(runId);
    res.json(await resultView(runId));
  }),
);

resultsRouter.get(
  '/results/:runId/clauses/:assessmentId',
  ah(async (req, res) => {
    const runId = num(req.params.runId);
    await assertRunOwner(req, runId);
    await assertSaved(runId);
    res.json(await clauseDetail(runId, num(req.params.assessmentId)));
  }),
);

resultsRouter.post(
  '/results/:runId/clauses/:assessmentId/rejudge',
  ah(async (req, res) => {
    const runId = num(req.params.runId);
    await assertRunOwner(req, runId);
    await assertSaved(runId);
    res.json(await rejudge(req, runId, num(req.params.assessmentId)));
  }),
);

for (const [path, fn] of [
  ['explanation', explanation],
  ['comparison', comparison],
  ['similar-cases', similarCases],
] as const) {
  resultsRouter.get(
    `/results/:runId/clauses/:assessmentId/${path}`,
    ah(async (req, res) => {
      const runId = num(req.params.runId);
      await assertRunOwner(req, runId);
      await assertSaved(runId);
      res.json(await fn(runId, num(req.params.assessmentId)));
    }),
  );
}

/** 판정 근거 집합에 속한 근거만, 그 판정이 붙은 결과의 소유자에게만 돌려준다 */
resultsRouter.get(
  '/evidence/:evidenceVersionId',
  ah(async (req, res) => {
    const id = num(req.params.evidenceVersionId);
    const owners = await select<{ request_id: number }>(
      getPool(),
      `SELECT DISTINCT r.request_id FROM judgment_evidence je
         JOIN clause_assessment a ON a.judgment_id = je.judgment_id JOIN analysis_run r ON r.run_id = a.run_id
        WHERE je.evidence_version_id = ?`,
      [id],
    );
    let owned = false;
    for (const o of owners) {
      try {
        await assertOwner(req, o.request_id);
        owned = true;
        break;
      } catch {
        /* 다음 후보 */
      }
    }
    if (!owned) throw new HttpError(404, 'not_found', '근거를 찾을 수 없습니다');
    const ev = (await evidenceVersion(id))!;
    res.json(toEvidenceDto(ev, ev.to_kv_id !== null));
  }),
);
