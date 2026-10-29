// 분석 접수(T068, P1 1.5~1.7): 트랜잭션 밖에서 G2→G3→G5 를 순서대로(이용 한도 G4 없음 — 로컬 모드) 선검사한 뒤(A2) 요청(H1)·문서를 만들고 P2 를 시작한다
import type { Request, Response } from 'express';
import { withTx } from '../../db/tx.js';
import type { Perspective } from '../../domain/codes.js';
import { deidentify } from '../deid/deid.service.js';
import { raise } from '../gates/gates.service.js';
import { assertModelServerReady } from '../modelApi/gate.js';
import { activeKnowledgeVersion } from '../evidence/evidence.repo.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { claimUpload, readUploadMeta } from './rawStore.js';
import { readUrlSource, type UrlSource } from './urlSources.js';
import { enqueue } from '../../jobs/runner.js';
import { runStructuring, setPendingText } from '../structuring/structuring.pipeline.js';

export type SourceInput = { kind: 'file'; uploadToken: string } | { kind: 'url'; sourceToken: string } | { kind: 'text'; text: string };

export async function createRequest(req: Request, res: Response, perspective: Perspective, source: SourceInput): Promise<{ requestId: number; knowledgeDate: string }> {
  const owner = req.owner;
  const subject = { userId: owner.userId, sessionId: null };

  // G2 — 업로드 토큰(사전 검사 통과분)이 이 기기의 것인지
  let upload = null as ReturnType<typeof readUploadMeta>;
  if (source.kind === 'file') {
    upload = readUploadMeta(source.uploadToken);
    if (!upload || upload.deviceKey !== owner.deviceKey) {
      await raise('G2', 'upload_missing', subject, { status: 400, params: { detail: '업로드한 파일을 찾을 수 없습니다. 다시 올려 주세요' } });
    }
  }
  // G3 — URL 수집 결과
  let url: UrlSource | null = null;
  if (source.kind === 'url') {
    url = readUrlSource(source.sourceToken, owner.deviceKey!);
    if (!url) await raise('G3', 'source_missing', subject, { params: { detail: '수집한 본문을 찾을 수 없습니다. URL 을 다시 입력해 주세요' } });
  }
  if (source.kind === 'text' && source.text.trim().length < 20) {
    throw new HttpError(400, 'text_too_short', '분석할 텍스트가 너무 짧습니다');
  }
  // G5 서버 상태 (요청 행을 만들기 전에 — SD_01 §4-3)
  await assertModelServerReady(subject);

  const kv = await activeKnowledgeVersion();
  if (!kv) throw new HttpError(503, 'no_knowledge_version', '지식 기준일이 준비되지 않았습니다. 운영자에게 문의해 주세요');

  const requestId = await withTx(async (conn) => {
    const [r] = await conn.query<import('mysql2').ResultSetHeader>(
      "INSERT INTO analysis_request (user_id, session_id, input_method, perspective, fixed_kv_id, stage) VALUES (?, ?, ?, ?, ?, 'received')",
      [owner.userId, null, source.kind, perspective, kv.kv_id],
    );
    const id = r.insertId;
    // 표시명은 우선 파일명 자체만 비식별화한다 — 본문에서 확정한 이름은 2.3 에서 다시 적용(A14)
    const displayName =
      source.kind === 'file' ? deidentify(upload!.originalName || '업로드 문서') : source.kind === 'url' ? deidentify(url!.displayName) : '붙여넣은 텍스트';
    const rawRef = source.kind === 'file' ? claimUpload(source.uploadToken, id) : null;
    await conn.query(
      `INSERT INTO document (request_id, doc_seq, display_name, file_format, source_url, collected_at, raw_file_ref)
       VALUES (?, 1, ?, ?, ?, ?, ?)`,
      [id, String(displayName).slice(0, 255), source.kind === 'file' ? upload!.format : source.kind === 'url' ? 'html' : null, url?.sourceUrl ?? null, url ? new Date(url.collectedAt) : null, rawRef],
    );
    return id;
  });

  if (source.kind === 'text') setPendingText(requestId, source.text);
  if (source.kind === 'url') setPendingText(requestId, url!.text);
  enqueue(requestId, 'structuring', (signal) => runStructuring(requestId, signal));
  return { requestId, knowledgeDate: kv.knowledge_date };
}
