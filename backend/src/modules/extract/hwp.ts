// HWP 5.0 추출(T100, research R-05·R-05a): hwp.js 로 BodyText 문단을 읽는다.
// FileHeader 속성(offset 36) bit1 = 암호, bit2 = 배포용 문서. 라이브러리 성숙도가 낮아 읽기 실패는
// 손상이 아니라 unsupported_variant("HWP 본문을 읽지 못했습니다 — HWPX·PDF 로 저장하거나 텍스트 붙여넣기")로 다룬다
import { createRequire } from 'node:module';
import type { ExtractedDoc, ProbeResult } from './index.js';

const require = createRequire(import.meta.url);
const SIGNATURE = Buffer.from('HWP Document File', 'latin1');

interface HwpChar {
  type: number;
  value: number | string;
}
interface HwpParagraph {
  content: HwpChar[];
  /** 표: content[행][열] = ParagraphList, 글상자: content[] = ParagraphList */
  controls?: { content?: unknown }[];
}
interface HwpModule {
  parse(input: Buffer, options?: { type: 'buffer' }): { sections: { content: HwpParagraph[] }[] };
}

/** FileHeader 스트림(256바이트)은 미니 스트림 한 섹터(64바이트) 안에서 서명으로 시작한다 — 서명 위치 +36 이 속성 DWORD */
export function hwpHeaderFlags(buf: Buffer): { encrypted: boolean; distribution: boolean } | null {
  const at = buf.indexOf(SIGNATURE);
  if (at < 0 || at + 40 > buf.length) return null;
  const attrs = buf.readUInt32LE(at + 36);
  return { encrypted: (attrs & 0x2) !== 0, distribution: (attrs & 0x4) !== 0 };
}

function paragraphText(p: HwpParagraph, out: string[]): void {
  let s = '';
  for (const c of p.content) {
    if (typeof c.value === 'string') s += c.value;
    else if (c.value === 10) s += ' '; // 줄 나눔
    else if (c.value === 9) s += ' '; // 탭
  }
  if (s.trim()) out.push(s.trim());
  // 표 셀 등 컨트롤 안 문단
  for (const ctrl of p.controls ?? []) {
    const rows = ctrl.content;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as unknown[]) {
      const cells = Array.isArray(row) ? row : [row];
      for (const cell of cells as { items?: HwpParagraph[] }[]) for (const q of cell?.items ?? []) paragraphText(q, out);
    }
  }
}

function parseHwp(buf: Buffer): string {
  const hwp = require('hwp.js') as HwpModule;
  const doc = hwp.parse(buf, { type: 'buffer' });
  const lines: string[] = [];
  for (const sec of doc.sections) for (const p of sec.content) paragraphText(p, lines);
  return lines.join('\n\n');
}

export async function probeHwp(buf: Buffer): Promise<ProbeResult> {
  const flags = hwpHeaderFlags(buf);
  if (!flags) return { encrypted: false, corrupt: true, pages: null };
  if (flags.encrypted) return { encrypted: true, corrupt: false, pages: null };
  // 사전 검사에서 본문까지 읽어 본다 — 못 읽으면 분석 전에 G2 unsupported_variant 로 안내(R-05a)
  if (flags.distribution) return { encrypted: false, corrupt: false, pages: null, failure: 'unsupported_variant' };
  try {
    const text = parseHwp(buf);
    return { encrypted: false, corrupt: false, pages: null, ...(text.trim() ? {} : { failure: 'unsupported_variant' as const }) };
  } catch {
    return { encrypted: false, corrupt: false, pages: null, failure: 'unsupported_variant' };
  }
}

export async function extractHwp(buf: Buffer): Promise<ExtractedDoc> {
  const flags = hwpHeaderFlags(buf);
  const fail = (failure: ExtractedDoc['failure']): ExtractedDoc => ({ text: '', pages: null, ocrApplied: false, lowQualitySpans: [], failure });
  if (!flags) return fail('corrupt');
  if (flags.encrypted) return fail('encrypted');
  if (flags.distribution) return fail('unsupported_variant');
  try {
    const text = parseHwp(buf);
    return text.trim() ? { text, pages: null, ocrApplied: false, lowQualitySpans: [] } : fail('unsupported_variant');
  } catch {
    return fail('unsupported_variant');
  }
}
