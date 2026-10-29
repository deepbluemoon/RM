// PDF 텍스트 추출(T066) — pdfjs-dist legacy 빌드. 쪽수·암호화·손상 판정과 페이지별 텍스트.
// 글자가 거의 없는 페이지는 needsOcr 로 표시만 한다(OCR 은 US3 extract/ocr.ts)
import type { PDFDocumentProxy, TextItem } from 'pdfjs-dist/types/src/display/api.js';

export class PdfError extends Error {
  constructor(public readonly kind: 'encrypted' | 'corrupt') {
    super(`pdf ${kind}`);
    this.name = 'PdfError';
  }
}

export interface PdfPage {
  pageNo: number;
  text: string;
  needsOcr: boolean;
}

export const OCR_MIN_CHARS = 20;

async function load(data: Buffer): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    return await pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'PasswordException') throw new PdfError('encrypted');
    throw new PdfError('corrupt');
  }
}

/** 사전 검사용 — 쪽수만 읽는다 */
export async function pdfPageCount(data: Buffer): Promise<number> {
  const doc = await load(data);
  const n = doc.numPages;
  await doc.destroy();
  return n;
}

/** 줄 단위로 텍스트를 복원한다 — 같은 y 좌표의 항목을 한 줄로 묶는다 */
function itemsToText(items: TextItem[]): string {
  const lines: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!('str' in it)) continue;
    const x = it.transform[4] as number;
    const y = it.transform[5] as number;
    let line = lines.find((l) => Math.abs(l.y - y) < 2);
    if (!line) {
      line = { y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, s: it.str });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.s)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

export async function extractPdf(data: Buffer): Promise<{ pages: PdfPage[]; numPages: number }> {
  const doc = await load(data);
  const pages: PdfPage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = itemsToText(content.items as TextItem[]);
      pages.push({ pageNo: i, text, needsOcr: text.replace(/\s/g, '').length < OCR_MIN_CHARS });
      page.cleanup();
    }
  } catch {
    throw new PdfError('corrupt');
  } finally {
    await doc.destroy();
  }
  return { pages, numPages: pages.length };
}
