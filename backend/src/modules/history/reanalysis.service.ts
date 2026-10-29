// 6.5~6.7 재분석(T116, UC5 기본흐름 4·5). 사전검증은 G5 만 — 한도(G4)는 보지 않는다(FR-034·035(e)).
// 새 실행 = run_kind 'reanalysis', prev_run_id = 저장된 이전 결과, kv_id = 지금 활성 기준일. 저장(6.7)은 results.saveRun 이
// run_kind 로 차감 여부를 가르므로 usage_charge 가 생기지 않는다
import type { Request } from 'express';
import { withTx } from '../../db/tx.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { enqueue } from '../../jobs/runner.js';
import { assertModelServerReady } from '../modelApi/gate.js';
import { activeKnowledgeVersion } from '../evidence/evidence.repo.js';
import { runReanalysis } from '../detection/detection.service.js';

const ACTIVE_STAGES = ['detecting', 'searching', 'explaining'];

export async function startReanalysis(req: Request, requestId: number, prevRunId: number): Promise<{ runId: number; knowledgeDate: string }> {
  const subject = { userId: req.owner.userId, sessionId: req.owner?.sessionId ?? null, requestId };
  // 6.5 서버 확인(G5) — 요청 전 차단, 실행 행을 만들지 않는다
  await assertModelServerReady(subject);
  const kv = await activeKnowledgeVersion();
  if (!kv) throw new HttpError(503, 'no_knowledge_version', '지식 기준일이 준비되지 않았습니다. 운영자에게 문의해 주세요');

  const runId = await withTx(async (conn) => {
    await conn.query('SELECT request_id FROM analysis_request WHERE request_id = ? FOR UPDATE', [requestId]);
    const [[prev]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT stage FROM analysis_run WHERE run_id = ? AND request_id = ?', [prevRunId, requestId]);
    if (!prev || prev.stage !== 'saved') throw new HttpError(404, 'run_not_found', '재분석할 결과를 찾을 수 없습니다');
    const [[busy]] = await conn.query<import('mysql2').RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM analysis_run WHERE request_id = ? AND stage IN (${ACTIVE_STAGES.map(() => '?').join(',')})`,
      [requestId, ...ACTIVE_STAGES],
    );
    if (Number(busy!.n) > 0) throw new HttpError(409, 'run_in_progress', '이 기록은 이미 분석 중입니다. 끝난 뒤 다시 시도해 주세요');
    // trg_run_bi: 재분석은 같은 요청의 저장된 결과만 참조할 수 있다(UC5)
    const [r] = await conn.query<import('mysql2').ResultSetHeader>(
      "INSERT INTO analysis_run (request_id, run_kind, prev_run_id, kv_id, stage) VALUES (?, 'reanalysis', ?, ?, 'detecting')",
      [requestId, prevRunId, kv.kv_id],
    );
    return r.insertId;
  });
  // 6.6 보관된 비식별 조항으로 P3 재분석 모드(M4 미호출)
  enqueue(requestId, 'reanalysis', (signal) => runReanalysis(runId, signal));
  return { runId, knowledgeDate: kv.knowledge_date };
}
