// P2 구조화 파이프라인(T071): 2.1 추출 → 2.2 계약서 판별(G6) → 2.3 비식별화(분할 전, 원본 삭제 예약) →
// 2.4 분할·clause INSERT(deid_text 만, 결합 파일은 문서별 doc_seq — UC1 A5, OCR 저품질 조항 표시 — FR-003) → 2.5 M4 요약(실패 시 요약·유형 후보 없음 — UC1 E8) → awaiting_type.
// 단계마다 request.stage 를 갱신한다. 취소(stopped)되면 조건부 UPDATE 가 0행이 되어 멈춘다.
import { exec, getPool } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { policy } from '../../config/policy.js';
import { logger } from '../../logger.js';
import { throwIfAborted, CancelledError } from '../../jobs/runner.js';
import { recordGate } from '../gates/gates.service.js';
import { deidentifyDocument, deidentify } from '../deid/deid.service.js';
import { modelApi } from '../modelApi/client.js';
import { normalizeContractType } from '../modelApi/adapter.js';
import { stripAssertiveSentences } from '../results/explanation.filter.js';
import { extractDocument, type ExtractedDoc } from '../extract/index.js';
import { getDocuments, getRequest } from '../analysis/analysis.repo.js';
import { readRaw } from '../intake/rawStore.js';
import { classifyContract } from './classifier.js';
import { splitDocuments } from './multiDoc.js';
import type { FileFormat } from '../../domain/codes.js';
import type { DeidentifiedText } from '../../domain/types.js';

const norm = (s: string) => s.replace(/\s+/g, '');

/** OCR 저품질 줄(공백 제거)이 조항 본문이나 조 머리말에 들어 있으면 그 조항은 저품질이다(FR-003, UC2 A4) */
function isLowQuality(c: { articleNo: string | null; title: string | null; text: string }, lowSpans: string[]): boolean {
  if (!lowSpans.length) return false;
  const body = norm(c.text);
  const head = c.articleNo ? norm(`${c.articleNo}(${c.title ?? ''})`) : '';
  if (body.length < 6) return false;
  return lowSpans.some((s) => body.includes(s) || (s.length >= 20 && s.includes(body.slice(0, 40))) || (head && s === head));
}

/** 텍스트·URL 입력의 원문 — DB·디스크에 쓰지 않고 파이프라인이 읽을 때까지만 메모리에 둔다 */
const pendingText = new Map<number, string>();
export const setPendingText = (id: number, text: string) => pendingText.set(id, text);

async function setStage(requestId: number, stage: string): Promise<void> {
  const r = await exec(getPool(), "UPDATE analysis_request SET stage = ? WHERE request_id = ? AND stage <> 'stopped'", [stage, requestId]);
  if (r.affectedRows === 0) throw new CancelledError();
}

async function extract(requestId: number): Promise<ExtractedDoc> {
  const text = pendingText.get(requestId);
  pendingText.delete(requestId);
  if (text !== undefined) return { text, pages: null, ocrApplied: false, lowQualitySpans: [] };
  const [doc] = await getDocuments(requestId);
  if (!doc?.raw_file_ref || !doc.file_format) return { text: '', pages: null, ocrApplied: false, lowQualitySpans: [], failure: 'empty' };
  return extractDocument(doc.file_format as FileFormat, readRaw(doc.raw_file_ref));
}

export async function runStructuring(requestId: number, signal: AbortSignal): Promise<void> {
  const req = await getRequest(requestId);
  if (!req || req.stage === 'stopped') return;
  try {
    // 2.1 추출
    await setStage(requestId, 'deidentifying');
    const ex = await extract(requestId);
    throwIfAborted(signal);
    const [doc] = await getDocuments(requestId);
    if (!doc) return;

    // 2.2 계약서 판별 — 원문은 메모리에서만 다룬다
    const verdict = classifyContract(ex.text);
    if (ex.failure || !verdict.isContract) {
      await withTx(async (conn) => {
        await conn.query("UPDATE analysis_request SET stage = 'stopped' WHERE request_id = ? AND stage <> 'stopped'", [requestId]);
        await conn.query('UPDATE document SET is_contract = FALSE, ocr_applied = ?, raw_delete_due_at = CURRENT_TIMESTAMP WHERE request_id = ?', [ex.ocrApplied, requestId]);
      });
      // 파일을 읽지 못한 경우(HWP 변형·암호·손상)는 G2 안내(research R-05a), 읽었지만 계약서가 아니면 G6
      const g2 = ex.failure === 'unsupported_variant' || ex.failure === 'encrypted' || ex.failure === 'corrupt';
      await recordGate(g2 ? 'G2' : 'G6', g2 ? ex.failure! : 'not_contract', { requestId, userId: req.user_id, sessionId: req.session_id });
      return;
    }

    // 2.3 비식별화 — 분할 전(SD_01 §5-3). 확정 이름은 표시명에도 적용(A14). 원본 삭제 예약 = 지금 + RAW_RETENTION_HOURS
    const deid = deidentifyDocument(ex.text, doc.display_name);
    const lowSpans = ex.lowQualitySpans.map((s) => norm(deidentify(s) as string)).filter((s) => s.length >= 6);
    await exec(
      getPool(),
      'UPDATE document SET display_name = ?, is_contract = TRUE, ocr_applied = ?, raw_delete_due_at = CURRENT_TIMESTAMP + INTERVAL ? HOUR WHERE document_id = ?',
      [String(deid.displayName).slice(0, 255), ex.ocrApplied, policy('RAW_RETENTION_HOURS'), doc.document_id],
    );
    throwIfAborted(signal);

    // 2.4 분할 — 결합된 복수 계약이면 문서를 나눈다(UC1 A5)
    await setStage(requestId, 'structuring');
    const parts = splitDocuments(deid.text);
    const docIds: { documentId: number; clauses: { clauseId: number; text: DeidentifiedText; articleNo: string | null; title: string | null }[] }[] = [];
    await withTx(async (conn) => {
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        let documentId = doc.document_id;
        if (i > 0) {
          const [d] = await conn.query<import('mysql2').ResultSetHeader>(
            `INSERT INTO document (request_id, doc_seq, display_name, file_format, source_url, collected_at, ocr_applied, is_contract, raw_file_ref, raw_delete_due_at)
             SELECT request_id, ?, CONCAT(LEFT(display_name, 240), ' (', ?, ')'), file_format, source_url, collected_at, ocr_applied, TRUE, NULL, NULL FROM document WHERE document_id = ?`,
            [i + 1, i + 1, doc.document_id],
          );
          documentId = d.insertId;
        }
        // 복수 문서면 문서 첫머리 제목(비식별 본문에서 뽑음)을 표시명으로 쓴다 — 탭에서 구분되게(SD_02 S4 복수 문서 전환)
        if (parts.length > 1 && part.title) {
          await conn.query('UPDATE document SET display_name = ? WHERE document_id = ?', [part.title.slice(0, 255), documentId]);
        }
        await conn.query('UPDATE document SET split_method = ? WHERE document_id = ?', [part.method, documentId]);
        const clauses: (typeof docIds)[number]['clauses'] = [];
        for (const c of part.clauses) {
          const low = isLowQuality(c, lowSpans);
          const [ins] = await conn.query<import('mysql2').ResultSetHeader>(
            'INSERT INTO clause (document_id, seq, article_no, paragraph_no, item_no, title, deid_text, low_ocr_quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [documentId, c.seq, c.articleNo, c.paragraphNo, c.itemNo, c.title?.slice(0, 200) ?? null, c.text, low],
          );
          clauses.push({ clauseId: ins.insertId, text: c.text as DeidentifiedText, articleNo: c.articleNo, title: c.title });
        }
        docIds.push({ documentId, clauses });
      }
    });
    throwIfAborted(signal);

    // 2.5 요약·유형 후보(M4). 실패해도 계속한다 — 사용자가 유형을 직접 고른다(UC1 E8)
    for (const d of docIds) {
      try {
        const s = await modelApi.summarize(d.clauses.map((c) => ({ clause_id: String(c.clauseId), text: c.text, article_no: c.articleNo, title: c.title })));
        const summary = stripAssertiveSentences(deidentify(s.summary ?? ''));
        const cand = (s.contract_type_candidates ?? []).map((c) => normalizeContractType(c.label)).find((c) => c !== null) ?? null;
        await exec(
          getPool(),
          "UPDATE document SET summary_status = ?, summary_text = ?, summary_model_version = ?, contract_type_candidate = ? WHERE document_id = ?",
          summary ? ['ok', summary, String(s.model_version).slice(0, 40), cand, d.documentId] : ['unavailable', null, null, cand, d.documentId],
        );
      } catch (e) {
        logger.warn({ requestId, err: (e as Error).message }, 'summarize failed — 요약 제공 불가');
        await exec(getPool(), "UPDATE document SET summary_status = 'unavailable', summary_text = NULL WHERE document_id = ?", [d.documentId]);
      }
      throwIfAborted(signal);
    }
    await setStage(requestId, 'awaiting_type');
  } catch (e) {
    if (e instanceof CancelledError) return;
    logger.error({ requestId, err: (e as Error).message }, 'structuring failed');
    // 시스템 실패 — 중단하고 한도는 차감하지 않는다(FR-035(d))
    await exec(getPool(), "UPDATE analysis_request SET stage = 'stopped' WHERE request_id = ? AND stage <> 'stopped'", [requestId]).catch(() => undefined);
    await recordGate('G5', 'structuring_failed', { requestId }).catch(() => undefined);
  } finally {
    pendingText.delete(requestId);
  }
}
