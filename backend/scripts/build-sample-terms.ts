// S1 예시 약관 파일 생성기(2026-10-01) — npm run samples:build
// 원천 = frontend/samples-src/*.txt(가상 약관 3종). 테스트 픽스처와 같은 생성기(PDF · HWP · HWPX)로 만들어 frontend/public/samples/ 에 쓴다.
// 만든 뒤 서버의 실제 경로(사전 검사 → 본문 추출 → 조 나누기 → 계약서 판별)로 다시 읽어 검사하고, 하나라도 어긋나면 실패(종료 코드 1)한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { buildHwp, buildHwpx } from './build-fixtures.js';
import { precheck } from '../src/modules/intake/precheck.js';
import { extractDocument, supportedFormats } from '../src/modules/extract/index.js';
import { sniffFormat } from '../src/modules/intake/formats.js';
import { splitDocuments } from '../src/modules/structuring/multiDoc.js';
import { classifyContract } from '../src/modules/structuring/classifier.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '..', '..', 'frontend', 'samples-src');
const OUT = path.resolve(here, '..', '..', 'frontend', 'public', 'samples');

/** 원천 → 결과 파일. 순서 = 화면 카드 순서(짧은 것부터 — 처음 써 보는 사람이 빨리 결과를 본다) */
const SAMPLES = [
  { src: '모람 콘텐츠 이용약관.txt', out: 'moram-content-terms.hwpx', format: 'hwpx' },
  { src: '모람 콘텐츠 서비스 이용약관.txt', out: 'moram-content-service-terms.pdf', format: 'pdf' },
  { src: '세모 온라인 학습 서비스 이용약관.txt', out: 'semo-online-learning-terms.hwp', format: 'hwp' },
] as const;

// PDF 글꼴 — 테스트 픽스처의 AppleGothic 은 둥근 따옴표(“ ”)가 깨져 보였다(2026-10-01 렌더 확인) → Apple SD Gothic Neo(TTC)
const FONT_TTC = '/System/Library/Fonts/AppleSDGothicNeo.ttc';
const FONT_REG = 'AppleSDGothicNeo-Regular';
const FONT_BOLD = 'AppleSDGothicNeo-Bold';

/** 예시용 PDF — 제목 · 장 · 조 머리말은 굵게, 본문 10.5pt. 글자는 원문 그대로(줄 단위) */
function samplePdf(file: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: text.split('\n')[0], Author: '예시(가상 약관)' } });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    doc.registerFont('r', FONT_TTC, FONT_REG);
    doc.registerFont('b', FONT_TTC, FONT_BOLD);
    // 줄바꿈은 띄어쓰기 단위로 직접 — pdfkit 은 한글을 글자 단위로 끊어 '의 / 무'처럼 낱말이 갈라졌다
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
    const wrap = (line: string): string[] => {
      const out: string[] = []
      let cur = ''
      for (const w of line.split(' ')) {
        const next = cur ? `${cur} ${w}` : w
        if (cur && doc.widthOfString(next) > width) { out.push(cur); cur = w } else cur = next
      }
      if (cur) out.push(cur)
      return out
    }
    // lineBreak:false 면 pdfkit 이 쪽 넘김도 하지 않는다(한 쪽에 몰려 0.49% 만 읽혔다) → 아래 여백에 닿으면 직접 새 쪽
    const put = (line: string, gap: number) => {
      for (const l of wrap(line)) {
        if (doc.y + doc.currentLineHeight(true) + gap > doc.page.height - doc.page.margins.bottom) doc.addPage()
        const y = doc.y
        doc.text(l, doc.page.margins.left, y, { lineBreak: false })
        doc.y = y + doc.currentLineHeight(true) + gap // lineBreak:false 면 커서도 내려가지 않는다(줄이 한자리에 겹쳤다) → 직접 내림
      }
    }
    text.split('\n').forEach((line, i) => {
      if (!line.trim()) return void doc.moveDown(0.5);
      if (i === 0) { doc.font('b').fontSize(17); put(line, 4); doc.moveDown(0.3) }
      else if (/^제\s*\d+\s*장/.test(line)) { doc.moveDown(0.4).font('b').fontSize(12.5); put(line, 3) }
      else if (/^제\s*\d+\s*조/.test(line)) { doc.font('b').fontSize(11); put(line, 2) }
      else { doc.font('r').fontSize(10.5); put(line, 2.5) }
    });
    doc.end();
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

/** 글꼴에 없는 글자(빈 네모로 보일 글자) 목록 */
// pdfkit 이 실제로 쓰는 글꼴 객체로 확인한다(fontkit 은 pdfkit 의 간접 의존이라 직접 들이지 않는다)
function missingGlyphs(text: string): string[] {
  const doc = new PDFDocument();
  const miss = new Set<string>();
  for (const name of [FONT_REG, FONT_BOLD]) {
    doc.registerFont(name, FONT_TTC, name).font(name);
    const f = (doc as unknown as { _font: { font: { hasGlyphForCodePoint(c: number): boolean } } })._font.font;
    for (const ch of new Set(text.replace(/\s/g, ''))) if (!f.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0)) miss.add(ch);
  }
  return [...miss];
}

const readText = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const squash = (t: string) => t.replace(/\s+/g, '');
const articleCount = (t: string) => t.split('\n').filter((l) => /^\s*제\s*\d{1,3}\s*조/.test(l)).length;

async function build() {
  for (const s of SAMPLES) {
    const text = readText(s.src);
    const paras = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const file = path.join(OUT, s.out);
    if (s.format === 'pdf') await samplePdf(file, text);
    else if (s.format === 'hwp') fs.writeFileSync(file, await buildHwp(paras));
    else fs.writeFileSync(file, await buildHwpx(paras));
  }
}

/** PDF 글자 줄 겹침 검사 — 한 쪽 안에서 서로 다른 줄이 같은 높이(2pt 이내)에 그려지면 겹친 것. 추출 보존율만으로는 못 잡았다(2026-10-01) */
async function pdfOverlaps(buf: Buffer): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false }).promise;
  let overlaps = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items as { str: string; transform: number[] }[];
    const rows = new Map<number, number>(); // y → 그 줄 첫 글자의 x
    for (const it of items) {
      if (!it.str.trim()) continue;
      const y = Math.round((it.transform[5] ?? 0) / 2);
      const x = it.transform[4] ?? 0;
      const prev = rows.get(y);
      if (prev !== undefined && x <= prev + 0.5) overlaps++; // 같은 높이에서 다시 왼쪽 끝부터 시작 = 다른 줄이 겹침
      if (prev === undefined || x < prev) rows.set(y, x);
    }
  }
  return overlaps;
}

async function verify(): Promise<boolean> {
  let ok = true;
  for (const s of SAMPLES) {
    const src = readText(s.src);
    const buf = fs.readFileSync(path.join(OUT, s.out));
    const sniff = await sniffFormat(buf, s.out);
    const pre = await precheck(buf, s.out, supportedFormats());
    const failed = pre.checks.filter((c) => !c.passed).map((c) => `${c.check}: ${c.message}`);
    const ex = await extractDocument(s.format, buf);
    // 글자 보존율 — 공백을 뺀 원문 글자 중 추출 본문에 순서대로 남은 비율(PDF 줄바꿈 · 글꼴 누락 확인)
    const a = squash(src), b = squash(ex.text);
    let i = 0;
    for (const ch of b) if (i < a.length && ch === a[i]) i++;
    const kept = i / a.length;
    const docs = splitDocuments(ex.text);
    const clauses = docs.reduce((n, d) => n + d.clauses.length, 0);
    const cls = classifyContract(ex.text);
    const expectArticles = articleCount(src);
    const gotArticles = articleCount(ex.text);
    const glyphs = s.format === 'pdf' ? missingGlyphs(src) : []
    const overlaps = s.format === 'pdf' ? await pdfOverlaps(buf) : 0
    const row = { file: s.out, sniffed: sniff.format, bytes: buf.length, pages: pre.pages ?? ex.pages, precheck: failed.length ? failed : 'pass', extractFailure: ex.failure ?? null, kept: `${(kept * 100).toFixed(2)}%`, articles: `${gotArticles}/${expectArticles}`, documents: docs.length, clauses, isContract: cls.isContract, ...(s.format === 'pdf' ? { missingGlyphs: glyphs, overlappingLines: overlaps } : {}) };
    const bad = glyphs.length > 0 || overlaps > 0 || sniff.format !== s.format || failed.length > 0 || !!ex.failure || kept < 0.995 || gotArticles !== expectArticles || docs.length !== 1 || clauses === 0 || !cls.isContract;
    if (bad) ok = false;
    process.stdout.write(`${bad ? 'FAIL' : 'ok  '} ${JSON.stringify(row)}\n`);
  }
  return ok;
}

async function main() {
  if (!process.argv.includes('--verify-only')) await build();
  const ok = await verify();
  if (!ok) process.exitCode = 1;
}

void main();
