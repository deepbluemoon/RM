// DOCX 추출(T099, research R-05): mammoth 로 문단 텍스트를 뽑는다.
// 암호화된 DOCX 는 ZIP 이 아니라 OLE(CFB) 컨테이너(EncryptedPackage)라 intake/formats.ts 서명 판별에서 먼저 걸러진다
import JSZip from 'jszip';
import type { ExtractedDoc, ProbeResult } from './index.js';

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function probeDocx(buf: Buffer): Promise<ProbeResult> {
  if (buf.subarray(0, 8).equals(OLE)) return { encrypted: true, corrupt: false, pages: null };
  try {
    const zip = await JSZip.loadAsync(buf);
    if (!zip.file('word/document.xml')) return { encrypted: false, corrupt: true, pages: null };
    // 쪽수는 docProps/app.xml 의 <Pages>(저장 시점 값)가 있을 때만 쓴다
    const app = await zip.file('docProps/app.xml')?.async('string');
    const m = app ? /<Pages>(\d+)<\/Pages>/.exec(app) : null;
    return { encrypted: false, corrupt: false, pages: m ? Number(m[1]) : null };
  } catch {
    return { encrypted: false, corrupt: true, pages: null };
  }
}

export async function extractDocx(buf: Buffer): Promise<ExtractedDoc> {
  const mammoth = (await import('mammoth')).default;
  try {
    const r = await mammoth.extractRawText({ buffer: buf });
    // mammoth 는 문단 사이를 빈 줄로 나눈다 — 문단 경계를 그대로 둔다(PDF 줄 잇기 대상 아님)
    const text = r.value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text, pages: null, ocrApplied: false, lowQualitySpans: [], ...(text ? {} : { failure: 'empty' as const }) };
  } catch {
    return { text: '', pages: null, ocrApplied: false, lowQualitySpans: [], failure: 'corrupt' };
  }
}
