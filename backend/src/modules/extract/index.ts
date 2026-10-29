// 형식별 추출기 등록 — 지원 형식의 단일 지점. US1 은 PDF 와 텍스트, US3(T099~T103)에서 HWP·HWPX·DOCX·HTML 과 스캔 PDF OCR 을 붙였다
import type { FileFormat } from '../../domain/codes.js';
import { extractPdf } from './pdfText.js';
import { extractDocx, probeDocx } from './docx.js';
import { extractHwpx, probeHwpx } from './hwpx.js';
import { extractHwp, probeHwp } from './hwp.js';
import { extractHtml, probeHtml } from './html.js';
import { ocrPdfPages } from './ocr.js';
import { logger } from '../../logger.js';

export interface ExtractedDoc {
  text: string;
  pages: number | null;
  ocrApplied: boolean;
  /** OCR 저품질 구간(원문 문자열) — 분할 후 조항에 low_ocr_quality 로 옮긴다 */
  lowQualitySpans: string[];
  /** 서식 안의 조 구분(HWP 등) 추출 실패 사유 — G2 unsupported_variant */
  failure?: 'unsupported_variant' | 'corrupt' | 'encrypted' | 'empty';
}

export interface ProbeResult {
  encrypted: boolean;
  corrupt: boolean;
  pages: number | null;
  /** 사전 검사에서 본문을 읽지 못한 변형(HWP — research R-05a) → G2 unsupported_variant */
  failure?: 'unsupported_variant';
}

export interface Extractor {
  probe(buf: Buffer): Promise<ProbeResult>;
  extract(buf: Buffer): Promise<ExtractedDoc>;
}

const registry = new Map<FileFormat, Extractor>();

registry.set('pdf', {
  async probe() {
    return { encrypted: false, corrupt: false, pages: null };
  },
  async extract(buf) {
    const r = await extractPdf(buf);
    const needs = r.pages.filter((p) => p.needsOcr);
    let ocrApplied = false;
    const lowQualitySpans: string[] = [];
    if (needs.length && ocrHook) {
      try {
        const o = await ocrHook(buf, needs.map((p) => p.pageNo));
        for (const pg of r.pages) {
          const t = o.pages.get(pg.pageNo);
          if (t !== undefined) pg.text = t;
        }
        lowQualitySpans.push(...o.lowQualitySpans);
        ocrApplied = o.pages.size > 0;
      } catch (e) {
        // 인식 실패 — 글자 층만으로 계속한다(대개 G6 계약서 아님으로 이어진다). 원문은 기록하지 않는다
        logger.warn({ err: (e as Error).message, pages: needs.length }, 'ocr failed');
      }
    }
    return { text: r.pages.map((p) => p.text).join('\n'), pages: r.numPages, ocrApplied, lowQualitySpans };
  },
});

export type OcrHook = (pdf: Buffer, pageNos: number[]) => Promise<{ pages: Map<number, string>; lowQualitySpans: string[] }>;
// 기본 = 로컬 tesseract.js kor(extract/ocr.ts). 테스트는 registerOcr 로 바꿀 수 있다
let ocrHook: OcrHook | null = ocrPdfPages;
export function registerOcr(hook: OcrHook | null): void {
  ocrHook = hook;
}

registry.set('docx', { probe: probeDocx, extract: extractDocx });
registry.set('hwpx', { probe: probeHwpx, extract: extractHwpx });
registry.set('hwp', { probe: probeHwp, extract: extractHwp });
registry.set('html', { probe: probeHtml, extract: extractHtml });

export function registerExtractor(format: FileFormat, ex: Extractor): void {
  registry.set(format, ex);
}

export function supportedFormats(): FileFormat[] {
  return [...registry.keys()];
}

export async function probeDocument(format: FileFormat, buf: Buffer): Promise<ProbeResult> {
  const ex = registry.get(format);
  return ex ? ex.probe(buf) : { encrypted: false, corrupt: true, pages: null };
}

export async function extractDocument(format: FileFormat, buf: Buffer): Promise<ExtractedDoc> {
  const ex = registry.get(format);
  if (!ex) return { text: '', pages: null, ocrApplied: false, lowQualitySpans: [], failure: 'unsupported_variant' };
  return ex.extract(buf);
}
