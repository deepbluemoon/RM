// 사전 검사(T067, 1.3, G2): 형식·크기·쪽수·암호화·손상. 결과 5항목을 늘 돌려준다(SD_02 §5 사전 검사 표)
import { policy } from '../../config/policy.js';
import type { FileFormat } from '../../domain/codes.js';
import { sniffFormat } from './formats.js';
import { pdfPageCount, PdfError } from '../extract/pdfText.js';
import { probeDocument } from '../extract/index.js';

export type CheckName = 'format' | 'size' | 'pages' | 'encrypted' | 'corrupt';
export interface PrecheckItem {
  check: CheckName;
  passed: boolean;
  message?: string;
}

export interface PrecheckOutcome {
  ok: boolean;
  format: FileFormat | null;
  pages: number | null;
  sizeBytes: number;
  checks: PrecheckItem[];
  /** G2 사유 문구(〈50MB·300쪽 한도 초과 / 암호화 / 손상 / 지원하지 않는 형식〉) */
  reason: string;
  /** gate_event.reason_code 를 검사 항목명 대신 쓸 때(HWP 본문 읽기 실패 = unsupported_variant — research R-05a) */
  reasonCode?: string;
}

/** R-05a 안내 — HWP 는 형식은 맞지만 이 서비스가 본문을 읽지 못한 경우 */
export const HWP_VARIANT_MESSAGE = 'HWP 본문을 읽지 못했습니다 - HWPX·PDF 로 저장하거나 텍스트 붙여넣기로 입력해 주세요';

/** 형식 = PDF·HWP·HWPX·DOCX·HTML(T103). 지원 목록은 extract/index.ts 등록부(supportedFormats)가 단일 지점 */
export async function precheck(buf: Buffer, originalName: string, supported: readonly FileFormat[]): Promise<PrecheckOutcome> {
  const maxMb = policy('FILE_MAX_MB');
  const maxPages = policy('FILE_MAX_PAGES');
  const sizeOk = buf.length <= maxMb * 1024 * 1024;
  const sniff = await sniffFormat(buf, originalName);
  const format = sniff.format && supported.includes(sniff.format) ? sniff.format : null;
  let encrypted = sniff.format === null && sniff.reason === 'encrypted_office';
  let corrupt = false;
  let pages: number | null = null;
  let variant = false;
  if (format === 'pdf') {
    try {
      pages = await pdfPageCount(buf);
    } catch (e) {
      if (e instanceof PdfError && e.kind === 'encrypted') encrypted = true;
      else corrupt = true;
    }
  } else if (format) {
    const probe = await probeDocument(format, buf);
    encrypted = probe.encrypted;
    corrupt = probe.corrupt;
    pages = probe.pages;
    variant = probe.failure === 'unsupported_variant';
  }
  const pagesOk = pages === null || pages <= maxPages;
  const formatOk = (format !== null || encrypted) && !variant;
  const formatMsg = variant ? HWP_VARIANT_MESSAGE : formatOk ? `${(format ?? sniff.format ?? 'docx').toUpperCase()} 형식` : '지원하지 않는 형식입니다';
  const checks: PrecheckItem[] = [
    { check: 'format', passed: formatOk, message: formatMsg },
    { check: 'size', passed: sizeOk, message: `${(buf.length / 1024 / 1024).toFixed(1)}MB / 한도 ${maxMb}MB` },
    { check: 'pages', passed: pagesOk, message: pages === null ? '쪽수 확인 대상 아님' : `${pages}쪽 / 한도 ${maxPages}쪽` },
    { check: 'encrypted', passed: !encrypted, message: encrypted ? '암호가 걸린 파일입니다' : '암호 없음' },
    { check: 'corrupt', passed: !corrupt, message: corrupt ? '파일이 손상되어 열 수 없습니다' : '정상' },
  ];
  const reasons: string[] = [];
  if (!sizeOk) reasons.push(`${maxMb}MB 한도 초과`);
  if (!pagesOk) reasons.push(`${maxPages}쪽 한도 초과`);
  if (encrypted) reasons.push('암호화');
  if (corrupt) reasons.push('손상');
  if (variant) reasons.push(`지원하지 않는 형식 - ${HWP_VARIANT_MESSAGE}`);
  else if (!formatOk) reasons.push('지원하지 않는 형식');
  return {
    ok: checks.every((c) => c.passed),
    format,
    pages,
    sizeBytes: buf.length,
    checks,
    reason: reasons.join(' / '),
    ...(variant && !encrypted && !corrupt && sizeOk && pagesOk ? { reasonCode: 'unsupported_variant' } : {}),
  };
}
