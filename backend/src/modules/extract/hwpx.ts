// HWPX 추출(T099, research R-05): ZIP(OWPML) → Contents/section*.xml 을 fast-xml-parser 로 읽어 hp:p 문단을 문서 순서대로 뽑는다.
// 표 안의 문단(hp:tbl > hp:tc > hp:subList > hp:p)도 바깥 문단 뒤에 이어 붙인다
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { ExtractedDoc, ProbeResult } from './index.js';

type Node = Record<string, unknown>;

async function sections(zip: JSZip): Promise<string[]> {
  // content.hpf spine 순서를 따르고, 없으면 section 번호 순
  const hpf = await zip.file('Contents/content.hpf')?.async('string');
  const names: string[] = [];
  if (hpf) {
    const items = new Map<string, string>();
    for (const m of hpf.matchAll(/<(?:opf:)?item\b[^>]*\bid="([^"]+)"[^>]*\bhref="([^"]+)"/g)) items.set(m[1]!, m[2]!);
    for (const m of hpf.matchAll(/<(?:opf:)?itemref\b[^>]*\bidref="([^"]+)"/g)) {
      const href = items.get(m[1]!);
      if (href && /section\d+\.xml$/i.test(href)) names.push(href.replace(/^\//, ''));
    }
  }
  if (!names.length) {
    names.push(
      ...Object.keys(zip.files)
        .filter((f) => /^Contents\/section\d+\.xml$/i.test(f))
        .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1])),
    );
  }
  return names;
}

const local = (tag: string) => tag.replace(/^[^:]+:/, '');

/** preserveOrder 트리에서 hp:p 마다 한 줄. 문단의 직접 글자(hp:run > hp:t)를 모으고, 안쪽 문단은 따로 이어 붙인다 */
function collect(nodes: Node[], out: string[]): void {
  for (const n of nodes) {
    const tag = Object.keys(n).find((k) => k !== ':@');
    if (!tag || tag === '#text') continue;
    const children = (n[tag] as Node[]) ?? [];
    if (local(tag) === 'p') {
      const nested: string[] = [];
      const text = paraText(children, nested);
      if (text.trim()) out.push(text.trim());
      out.push(...nested);
    } else collect(children, out);
  }
}

function paraText(nodes: Node[], nested: string[]): string {
  let s = '';
  for (const n of nodes) {
    const tag = Object.keys(n).find((k) => k !== ':@');
    if (!tag) continue;
    const children = n[tag] as Node[] | string;
    const name = local(tag);
    if (tag === '#text') continue;
    if (name === 't') s += textOf(children as Node[]);
    else if (name === 'lineBreak') s += ' ';
    else if (name === 'tab') s += ' ';
    else if (name === 'run') s += paraText(children as Node[], nested);
    else collect(children as Node[], nested); // 표·글상자 등 안쪽 문단
  }
  return s;
}

function textOf(nodes: Node[]): string {
  let s = '';
  for (const n of nodes ?? []) {
    if ('#text' in n) s += String(n['#text']);
    else {
      const tag = Object.keys(n).find((k) => k !== ':@');
      if (tag && ['tab', 'lineBreak'].includes(local(tag))) s += ' ';
    }
  }
  return s;
}

export async function probeHwpx(buf: Buffer): Promise<ProbeResult> {
  try {
    const zip = await JSZip.loadAsync(buf);
    // 암호 설정 문서는 manifest 에 encryption-data 가 있다
    const manifest = await zip.file('META-INF/manifest.xml')?.async('string');
    if (manifest && /encryption-data/i.test(manifest)) return { encrypted: true, corrupt: false, pages: null };
    if (!(await sections(zip)).length) return { encrypted: false, corrupt: true, pages: null };
    return { encrypted: false, corrupt: false, pages: null };
  } catch {
    return { encrypted: false, corrupt: true, pages: null };
  }
}

export async function extractHwpx(buf: Buffer): Promise<ExtractedDoc> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: true, trimValues: false, processEntities: true, parseTagValue: false });
    const lines: string[] = [];
    for (const name of await sections(zip)) {
      const xml = await zip.file(name)?.async('string');
      if (xml) collect(parser.parse(xml) as Node[], lines);
    }
    const text = lines.join('\n\n');
    return { text, pages: null, ocrApplied: false, lowQualitySpans: [], ...(text ? {} : { failure: 'empty' as const }) };
  } catch {
    return { text: '', pages: null, ocrApplied: false, lowQualitySpans: [], failure: 'corrupt' };
  }
}
