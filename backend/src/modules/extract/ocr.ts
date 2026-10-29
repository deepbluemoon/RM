// 스캔형 PDF 문자 인식(T101, FR-003, research R-05): needsOcr 페이지의 쪽 이미지를 tesseract.js kor 로 인식한다.
// 학습 데이터는 설치된 @tesseract.js-data/kor 의 로컬 파일만 쓴다(langPath 로컬 경로 — CDN·외부 전송 없음, BR-MDL-01).
// 캔버스 없이 동작하도록 PDF 안에 박힌 쪽 이미지(XObject)를 꺼내 PNG 로 바꿔 넘긴다.
// 줄 단위 단어 신뢰도 평균이 기준 미만이면 그 줄을 저품질 구간으로 돌려주고, 분할 후 해당 조항에 low_ocr_quality 를 붙인다.
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import type { Worker } from 'tesseract.js';

/** 단어 신뢰도 평균 기준(0~100) [가정 — 운영 표본으로 보정] */
export const OCR_MIN_CONFIDENCE = 70;
/** 유휴 워커 정리 시간 */
const IDLE_MS = 30_000;

const require = createRequire(import.meta.url);

let workerP: Promise<Worker> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let chain: Promise<unknown> = Promise.resolve();

function langPath(): string {
  // { code:'kor', gzip:true, langPath:<node_modules/@tesseract.js-data/kor/4.0.0> }
  return (require('@tesseract.js-data/kor') as { langPath: string }).langPath;
}

async function worker(): Promise<Worker> {
  if (!workerP) {
    workerP = (async () => {
      const { createWorker, OEM } = await import('tesseract.js');
      // cacheMethod 'none' — 학습 데이터를 작업 디렉터리에 캐시로 쓰지 않는다
      return createWorker('kor', OEM.LSTM_ONLY, { langPath: langPath(), gzip: true, cacheMethod: 'none' });
    })();
    workerP.catch(() => (workerP = null));
  }
  return workerP;
}

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void terminateOcr(), IDLE_MS);
  idleTimer.unref();
}

export async function terminateOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = workerP;
  workerP = null;
  if (w) await (await w).terminate().catch(() => undefined);
}

interface RawImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

/** pdfjs 이미지 객체(kind 1=1bpp 흑백, 2=RGB, 3=RGBA) → PNG */
function toPng(img: RawImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  const n = img.width * img.height;
  const src = img.data;
  const dst = png.data;
  if (img.kind === 3) dst.set(src.subarray(0, n * 4));
  else if (img.kind === 2) {
    for (let i = 0; i < n; i++) {
      dst[i * 4] = src[i * 3]!;
      dst[i * 4 + 1] = src[i * 3 + 1]!;
      dst[i * 4 + 2] = src[i * 3 + 2]!;
      dst[i * 4 + 3] = 255;
    }
  } else {
    const rowBytes = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const bit = (src[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * img.width + x) * 4;
        dst[o] = dst[o + 1] = dst[o + 2] = v;
        dst[o + 3] = 255;
      }
    }
  }
  return PNG.sync.write(png);
}

/** 쪽마다 가장 큰 이미지(스캔 쪽 이미지)를 PNG 로 꺼낸다 */
async function pageImages(pdf: Buffer, pageNos: number[]): Promise<Map<number, Buffer>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    verbosity: 0,
  }).promise;
  const out = new Map<number, Buffer>();
  try {
    for (const no of pageNos) {
      const page = await doc.getPage(no);
      const ops = await page.getOperatorList();
      let best: RawImage | null = null;
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] !== pdfjs.OPS.paintImageXObject) continue;
        const name = ops.argsArray[i][0] as string;
        const store = name.startsWith('g_') ? page.commonObjs : page.objs;
        const img = await new Promise<RawImage | null>((resolve) => {
          try {
            store.get(name, (v: unknown) => resolve((v as RawImage) ?? null));
          } catch {
            resolve(null);
          }
        });
        if (img?.data && (!best || img.width * img.height > best.width * best.height)) best = img;
      }
      if (best) out.set(no, toPng(best));
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

interface OcrLine {
  text: string;
  confidence: number;
}

/** 줄 목록과 줄별 단어 신뢰도 평균 */
async function recognize(png: Buffer): Promise<OcrLine[]> {
  const w = await worker();
  const { data } = await w.recognize(png);
  const lines: OcrLine[] = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs) {
      for (const l of p.lines) {
        const words = l.words.filter((x) => x.text.trim());
        if (!words.length) continue;
        const text = joinWords(words, l.bbox.y1 - l.bbox.y0);
        lines.push({ text: text.trim(), confidence: words.reduce((a, x) => a + x.confidence, 0) / words.length });
      }
    }
  }
  return lines;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

type Box = { x0: number; x1: number };
interface OcrWord {
  text: string;
  bbox: Box;
  symbols?: { bbox: Box }[];
}

/** 한글 인식 결과는 음절마다 낱말로 끊긴다 — 앞 낱말 마지막 글자와 다음 낱말 첫 글자의 중심 거리로 띄어쓰기를 되살린다.
 *  한글 글자 폭은 거의 일정해 같은 낱말 안은 줄 높이의 약 1.1배, 띄어쓴 곳은 1.3배 이상이다(글자 상자 가장자리 간격보다 안정적).
 *  중심 거리가 비정상이면 상자 간격(줄 높이의 50%)으로 판단한다. 쉼표·마침표 뒤는 띄운다.
 *  줄 머리 "(2)"·"0)" 은 원문자 항 번호(②·①)를 잘못 읽은 것으로 보고 되돌린다 */
function joinWords(words: OcrWord[], h: number): string {
  const cx = (b: Box) => (b.x0 + b.x1) / 2;
  let s = '';
  let prev: OcrWord | null = null;
  for (const w of words) {
    if (prev) {
      let space: boolean;
      if (/[,.;:!?]$/.test(prev.text)) space = true;
      else {
        const a = prev.symbols?.[prev.symbols.length - 1]?.bbox ?? prev.bbox;
        const b = w.symbols?.[0]?.bbox ?? w.bbox;
        const d = (cx(b) - cx(a)) / h;
        space = d >= 0.5 && d <= 2.2 ? d > 1.27 : w.bbox.x0 - prev.bbox.x1 > h * 0.5;
      }
      if (space) s += ' ';
    }
    s += w.text;
    prev = w;
  }
  return s
    .trim()
    .replace(/^[(（]([1-9]|1\d|20)[)）]\s*/, (_m, n: string) => `${CIRCLED[Number(n) - 1]} `)
    .replace(/^[0oO][)）]\s*/, '① ')
    .replace(/제\s*(\d{1,3})\s*조/g, '제$1조');
}

/** OcrHook 구현 — extract/index.ts 가 needsOcr 페이지에 부른다. 순차 실행(워커 1개) */
export async function ocrPdfPages(pdf: Buffer, pageNos: number[]): Promise<{ pages: Map<number, string>; lowQualitySpans: string[] }> {
  const run = async () => {
    const imgs = await pageImages(pdf, pageNos);
    const pages = new Map<number, string>();
    const lowQualitySpans: string[] = [];
    for (const [no, png] of imgs) {
      const lines = await recognize(png);
      pages.set(no, lines.map((l) => l.text).join('\n'));
      for (const l of lines) if (l.confidence < OCR_MIN_CONFIDENCE) lowQualitySpans.push(l.text);
    }
    return { pages, lowQualitySpans };
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  try {
    return await p;
  } finally {
    touchIdle();
  }
}
