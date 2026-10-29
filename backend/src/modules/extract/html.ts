// HTML 본문 추출(T102, research R-05): jsdom(스크립트 실행·외부 자원 적재 없음) + @mozilla/readability 로 본문 영역을 고르고,
// cheerio 로 블록 경계를 줄바꿈으로 바꿔 텍스트로 만든다. 업로드한 .html 파일과 URL 수집이 같이 쓴다.
// 로그인 폼(비밀번호 입력란) 여부도 함께 돌려준다 — URL 수집의 G3 판정에 쓴다
import type { ExtractedDoc, ProbeResult } from './index.js';

export interface HtmlBody {
  text: string;
  title: string | null;
  hasPasswordField: boolean;
}

const BLOCK = 'address, article, aside, blockquote, dd, div, dl, dt, figcaption, footer, form, h1, h2, h3, h4, h5, h6, header, li, main, nav, ol, p, pre, section, table, tr, ul';

/** 블록 요소마다 문단 경계를 넣고, 문단 안의 소스 공백은 한 칸으로 줄인다 */
async function blocksToText(html: string): Promise<string> {
  const cheerio = await import('cheerio');
  const $ = cheerio.load(html);
  $('script, style, noscript, template, svg, iframe').remove();
  // 경계 표지 = 사용자 정의 영역 문자(HTML 파서가 NUL 은 U+FFFD 로 바꾼다)
  const MARK = '\ue000';
  $('br').replaceWith(MARK);
  $(BLOCK).each((_i, el) => {
    $(el).prepend(MARK + MARK);
    $(el).append(MARK + MARK);
  });
  const raw = $.root().text();
  return raw
    .replace(/[ \t\r\n\f\v\u00a0]+/g, ' ')
    .replace(/\ue000 +\ue000/g, '\ue000\ue000')
    .split(/\ue000\ue000+/)
    .flatMap((b) => b.split('\ue000').map((l) => l.trim()))
    .filter(Boolean)
    .join('\n\n');
}

export async function htmlToText(html: string, url = 'http://localhost/'): Promise<HtmlBody> {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  // 스크립트는 실행하지 않고(runScripts 미지정), 하위 자원도 받지 않는다(resources 미지정)
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  const hasPasswordField = doc.querySelector('input[type="password" i]') !== null;
  const pageTitle = doc.title?.trim() || null;
  let text = '';
  let title = pageTitle;
  try {
    const art = new Readability(doc.cloneNode(true) as Document, { charThreshold: 200 }).parse();
    if (art?.content) {
      text = await blocksToText(art.content);
      title = art.title?.trim() || pageTitle;
      // 제목이 본문 첫 줄에 없으면 앞에 붙인다(약관 제목 — 복수 문서 구분·표시명에 쓰인다)
      if (title && !text.startsWith(title) && /(약관|계약서|계약|규정|방침)$/.test(title)) text = `${title}\n\n${text}`;
    }
  } catch {
    text = '';
  }
  if (!text) {
    // 본문 영역을 못 고르면 머리·탐색·바닥글을 빼고 body 전체를 쓴다
    doc.querySelectorAll('header, nav, footer, aside, form').forEach((e) => e.remove());
    text = await blocksToText(doc.body?.innerHTML ?? '');
  }
  dom.window.close();
  return { text, title, hasPasswordField };
}

/** 문서 안에 선언된 문자 집합(meta charset)을 읽는다 — 없으면 utf-8 */
export function decodeHtml(buf: Buffer, contentTypeCharset?: string | null): string {
  let cs = contentTypeCharset?.trim().toLowerCase() || null;
  if (!cs) {
    const head = buf.subarray(0, 2048).toString('latin1');
    cs = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() ?? 'utf-8';
  }
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

export async function probeHtml(buf: Buffer): Promise<ProbeResult> {
  return { encrypted: false, corrupt: buf.length === 0, pages: null };
}

export async function extractHtml(buf: Buffer): Promise<ExtractedDoc> {
  const r = await htmlToText(decodeHtml(buf));
  return { text: r.text, pages: null, ocrApplied: false, lowQualitySpans: [], ...(r.text ? {} : { failure: 'empty' as const }) };
}
