// 파일 형식 판별 — 확장자가 아니라 내용(서명)으로 본다(BR-INP-01)
import JSZip from 'jszip';
import type { FileFormat } from '../../domain/codes.js';

export type Sniffed = { format: FileFormat; encrypted?: boolean } | { format: null; reason: 'unsupported' | 'encrypted_office' };

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

export async function sniffFormat(buf: Buffer, originalName = ''): Promise<Sniffed> {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (head.startsWith('%PDF')) return { format: 'pdf' };
  if (buf.subarray(0, 8).equals(OLE)) {
    // OLE(CFB): HWP 5.0 또는 암호화된 OOXML(DOCX) 컨테이너
    const s = buf.toString('latin1');
    if (s.includes('HWP Document File')) return { format: 'hwp' };
    if (s.includes('E\u0000n\u0000c\u0000r\u0000y\u0000p\u0000t\u0000e\u0000d\u0000P\u0000a\u0000c\u0000k\u0000a\u0000g\u0000e') || /\.docx$/i.test(originalName)) {
      return { format: null, reason: 'encrypted_office' };
    }
    return { format: null, reason: 'unsupported' };
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    try {
      const zip = await JSZip.loadAsync(buf);
      if (zip.file('word/document.xml')) return { format: 'docx' };
      const mime = await zip.file('mimetype')?.async('string');
      if (mime?.includes('hwp') || zip.file('Contents/section0.xml')) return { format: 'hwpx' };
    } catch {
      return { format: null, reason: 'unsupported' };
    }
    return { format: null, reason: 'unsupported' };
  }
  const text = buf.subarray(0, 2048).toString('utf8').trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html') || (/\.html?$/i.test(originalName) && text.startsWith('<'))) return { format: 'html' };
  return { format: null, reason: 'unsupported' };
}
