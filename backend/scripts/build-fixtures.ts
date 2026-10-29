// 테스트 픽스처 생성기(T058·T097·T105) — npm run fixtures:build (형식 변형만: npm run fixtures:build -- formats)
// 모든 내용은 가상이다. 한글 PDF 는 macOS AppleGothic 글꼴로 만든다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { PII_CONTRACT_LINES, PII_CONTRACT_TEXT } from '../tests/fixtures/pii/contract-with-pii.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.resolve(here, '..', 'tests', 'fixtures');
const FONT = '/System/Library/Fonts/Supplemental/AppleGothic.ttf';

export interface Article {
  no: number;
  title: string;
  paragraphs: string[];
}

/** 구독 약관 표본 — 40개 조, 불공정 조항 5개(라벨 = labels.json) */
export const SUBSCRIPTION_ARTICLES: Article[] = [
  { no: 1, title: '목적', paragraphs: ['이 약관은 주식회사 가상스터디(이하 "회사")가 제공하는 온라인 강의 구독 서비스(이하 "서비스")의 이용 조건과 절차, 회사와 회원의 권리·의무를 정함을 목적으로 한다.'] },
  { no: 2, title: '정의', paragraphs: ['"회원"이란 이 약관에 동의하고 회사와 서비스 이용계약을 체결한 자를 말한다.', '"구독료"란 회원이 서비스를 이용하기 위하여 매월 지급하는 이용 대가를 말한다.'] },
  { no: 3, title: '약관의 명시와 개정', paragraphs: ['회사는 이 약관의 내용을 회원이 쉽게 알 수 있도록 서비스 초기 화면에 게시한다.', '회사가 약관을 개정할 경우에는 적용일자 및 개정사유를 명시하여 적용일자 7일 전부터 공지한다.'] },
  { no: 4, title: '이용계약의 성립', paragraphs: ['이용계약은 회원이 되고자 하는 자가 약관에 동의하고 회사가 정한 절차에 따라 가입을 신청한 후 회사가 이를 승낙함으로써 성립한다.'] },
  { no: 5, title: '구독 상품', paragraphs: ['회사는 월간 구독 상품과 연간 구독 상품을 제공하며, 각 상품의 가격과 내용은 서비스 화면에 표시한다.'] },
  { no: 6, title: '구독료의 결제', paragraphs: ['회원은 신용카드, 계좌이체 등 회사가 정한 방법으로 구독료를 결제한다.', '월간 구독료는 매월 결제일에 자동으로 청구된다.'] },
  { no: 7, title: '무료 체험', paragraphs: ['회사는 신규 회원에게 7일간의 무료 체험 기간을 제공할 수 있으며, 유료 전환 3일 전까지 회원에게 전환 사실과 결제 예정 금액을 알린다.'] },
  { no: 8, title: '서비스의 제공', paragraphs: ['회사는 회원에게 강의 영상 시청, 학습 자료 내려받기, 질의응답 게시판 이용 기능을 제공한다.'] },
  { no: 9, title: '서비스 이용 시간', paragraphs: ['서비스는 연중무휴 1일 24시간 제공함을 원칙으로 한다. 다만 시스템 점검 등 불가피한 경우 사전에 공지하고 일시 중단할 수 있다.'] },
  { no: 10, title: '회원의 의무', paragraphs: ['회원은 관계 법령과 이 약관을 준수하여야 하며, 회사의 업무에 지장을 주는 행위를 하여서는 아니 된다.'] },
  { no: 11, title: '계정 관리', paragraphs: ['회원은 자신의 계정 정보를 타인에게 양도하거나 대여할 수 없다.'] },
  { no: 12, title: '중도 해지와 위약금', paragraphs: ['회원이 구독 기간 중 해지하는 경우 회사는 잔여 기간 이용료 전액을 위약금으로 청구하며, 이미 결제한 구독료는 반환하지 않는다.'] },
  { no: 13, title: '청약철회', paragraphs: ['회원은 결제일부터 7일 이내에 강의를 수강하지 않은 경우 청약을 철회할 수 있다.'] },
  { no: 14, title: '환불 절차', paragraphs: ['회사는 청약철회 요청을 받은 날부터 3영업일 이내에 결제 수단으로 구독료를 환급한다.'] },
  { no: 15, title: '할인 상품의 환불', paragraphs: ['할인가로 결제한 구독 상품은 어떠한 경우에도 환불하지 않으며, 회원은 이에 대하여 이의를 제기할 수 없다.'] },
  { no: 16, title: '자동 갱신', paragraphs: ['구독 기간이 끝나면 동일한 조건으로 자동 갱신된다. 회사는 갱신 7일 전까지 회원에게 갱신 사실을 알린다.'] },
  { no: 17, title: '구독의 일시 정지', paragraphs: ['회원은 연 1회, 최대 30일까지 구독을 일시 정지할 수 있다.'] },
  { no: 18, title: '서비스 내용의 변경', paragraphs: ['회사는 사전 통지 없이 서비스 내용과 구독료를 변경할 수 있으며, 변경된 내용은 즉시 효력을 가진다.'] },
  { no: 19, title: '강의 콘텐츠의 저작권', paragraphs: ['서비스에서 제공하는 강의 콘텐츠의 저작권은 회사 또는 강사에게 있다.'] },
  { no: 20, title: '콘텐츠 이용 제한', paragraphs: ['회원은 강의 콘텐츠를 녹화, 복제, 배포하여서는 아니 된다.'] },
  { no: 21, title: '서비스 장애', paragraphs: ['회사는 서비스 장애가 발생한 경우 지체 없이 복구하도록 노력한다.'] },
  { no: 22, title: '회사의 면책', paragraphs: ['회사는 서비스 이용과 관련하여 회원에게 발생한 어떠한 손해에 대해서도 책임을 지지 않는다.'] },
  { no: 23, title: '회원 탈퇴', paragraphs: ['회원은 언제든지 서비스 화면의 탈퇴 메뉴를 통하여 탈퇴를 요청할 수 있다.'] },
  { no: 24, title: '이용 제한', paragraphs: ['회사는 회원이 이 약관을 위반한 경우 사전 통지 후 서비스 이용을 제한할 수 있다.'] },
  { no: 25, title: '개인정보 보호', paragraphs: ['회사는 관계 법령에 따라 회원의 개인정보를 보호하며, 개인정보 처리방침을 별도로 게시한다.'] },
  { no: 26, title: '통지', paragraphs: ['회사가 회원에게 통지하는 경우 회원이 등록한 전자우편 또는 서비스 내 알림으로 할 수 있다.'] },
  { no: 27, title: '분쟁의 해결', paragraphs: ['회원은 서비스 이용과 관련하여 회사를 상대로 어떠한 소송도 제기할 수 없으며, 모든 분쟁은 회사의 결정에 따른다.'] },
  { no: 28, title: '포인트', paragraphs: ['회사는 이벤트 참여 등에 따라 회원에게 포인트를 지급할 수 있으며, 포인트의 유효기간은 지급일부터 1년이다.'] },
  { no: 29, title: '쿠폰', paragraphs: ['쿠폰은 회사가 정한 조건에 따라 구독료 결제 시 사용할 수 있다.'] },
  { no: 30, title: '미성년자의 이용', paragraphs: ['미성년자가 결제하는 경우 법정대리인의 동의를 받아야 하며, 동의 없는 결제는 취소할 수 있다.'] },
  { no: 31, title: '학습 기록', paragraphs: ['회사는 회원의 학습 진도와 시청 기록을 서비스 개선에 활용할 수 있다.'] },
  { no: 32, title: '수료증', paragraphs: ['회사는 강의를 모두 수강한 회원에게 전자 수료증을 발급할 수 있다.'] },
  { no: 33, title: '고객 문의', paragraphs: ['회원은 서비스 화면의 고객센터 메뉴를 통하여 문의할 수 있으며, 회사는 영업일 기준 2일 이내에 답변한다.'] },
  { no: 34, title: '서비스 종료', paragraphs: ['회사가 서비스를 종료하는 경우 종료일 30일 전까지 공지하고 잔여 구독료를 일할 계산하여 환급한다.'] },
  { no: 35, title: '양도 금지', paragraphs: ['회원은 이용계약상의 지위를 타인에게 양도할 수 없다.'] },
  { no: 36, title: '손해배상', paragraphs: ['회사 또는 회원이 이 약관을 위반하여 상대방에게 손해를 입힌 경우 그 손해를 배상한다.'] },
  { no: 37, title: '재판관할', paragraphs: ['서비스 이용과 관련한 소송은 민사소송법에 따른 관할 법원에 제기한다.'] },
  { no: 38, title: '준거법', paragraphs: ['이 약관의 해석과 적용에는 대한민국 법령을 적용한다.'] },
  { no: 39, title: '약관 외 준칙', paragraphs: ['이 약관에서 정하지 아니한 사항은 관계 법령 또는 상관례에 따른다.'] },
  { no: 40, title: '시행일', paragraphs: ['이 약관은 2026년 9월 1일부터 시행한다.'] },
];

export const SUBSCRIPTION_LABELS = {
  $comment: '구독 약관 표본의 불공정 조항 라벨(가상). 조 번호 기준',
  articleCount: 40,
  unfair: [
    { article: '제12조', type: 'excessive_penalty' },
    { article: '제15조', type: 'refund_cancel_limit' },
    { article: '제18조', type: 'unilateral_change' },
    { article: '제22조', type: 'liability_avoid' },
    { article: '제27조', type: 'rights_limit' },
  ],
};

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

export function articlesToText(title: string, articles: Article[]): string {
  const lines = [title, ''];
  for (const a of articles) {
    lines.push(`제${a.no}조(${a.title})`);
    if (a.paragraphs.length === 1) lines.push(a.paragraphs[0]!);
    else a.paragraphs.forEach((p, i) => lines.push(`${CIRCLED[i]} ${p}`));
  }
  return lines.join('\n');
}

export function writePdf(file: string, text: string, opts: { userPassword?: string; pages?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, ...(opts.userPassword ? { userPassword: opts.userPassword, ownerPassword: opts.userPassword + '-owner' } : {}) });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    doc.registerFont('ko', FONT);
    doc.font('ko').fontSize(10.5);
    if (opts.pages) {
      for (let i = 0; i < opts.pages; i++) {
        if (i) doc.addPage();
        doc.text(`${i + 1}쪽 — ${text}`);
      }
    } else {
      for (const line of text.split('\n')) doc.text(line || ' ', { lineGap: 2 });
    }
    doc.end();
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

export const RECEIPT_TEXT = [
  '영 수 증',
  '가상마트 강남점',
  '2026-09-20 14:32',
  '우유 1L            2,900',
  '식빵               3,500',
  '사과 3입           7,800',
  '합계              14,200',
  '부가세 포함',
  '카드 승인번호 12345678',
  '감사합니다. 또 방문해 주세요.',
].join('\n');

/** T105 개인정보 표본(PDF·DOCX). 파일명에도 이름을 넣는다 — 테스트는 업로드 파일명으로 PII_FILE_BASENAME 을 쓴다 */
export async function buildPiiFixtures(): Promise<void> {
  const dir = path.join(FX, 'pii');
  fs.mkdirSync(dir, { recursive: true });
  await writePdf(path.join(dir, 'contract-with-pii.pdf'), PII_CONTRACT_TEXT);
  const { Document, Packer, Paragraph, TextRun } = await import('docx');
  const doc = new Document({
    creator: 'fixture',
    sections: [{ children: PII_CONTRACT_LINES.map((l) => new Paragraph({ children: [new TextRun(l)] })) }],
  });
  fs.writeFileSync(path.join(dir, 'contract-with-pii.docx'), await Packer.toBuffer(doc));
}

// ---------------------------------------------------------------- US3 형식 변형(T097) — tests/fixtures/contracts/formats/
const SUB_TITLE = '가상스터디 온라인 강의 구독 서비스 이용약관';

/** 두 번째 약관(결합 파일용) — 가상 쇼핑몰 */
export const SHOP_ARTICLES: Article[] = [
  { no: 1, title: '목적', paragraphs: ['이 약관은 가상마켓(이하 "몰")이 운영하는 인터넷 쇼핑몰에서 제공하는 전자상거래 관련 서비스의 이용 조건을 정함을 목적으로 한다.'] },
  { no: 2, title: '정의', paragraphs: ['"이용자"란 몰에 접속하여 이 약관에 따라 몰이 제공하는 서비스를 받는 회원 및 비회원을 말한다.'] },
  { no: 3, title: '구매 신청', paragraphs: ['이용자는 몰에서 상품을 선택하고 배송지와 결제 방법을 입력하여 구매를 신청한다.'] },
  { no: 4, title: '계약의 성립', paragraphs: ['몰은 구매 신청에 대하여 승낙의 의사표시를 전자우편으로 통지하며, 이때 계약이 성립한다.'] },
  { no: 5, title: '배송', paragraphs: ['몰은 이용자가 구매한 상품을 주문일부터 7일 이내에 배송한다.'] },
  { no: 6, title: '청약철회', paragraphs: ['이용자는 상품을 받은 날부터 7일 이내에 청약을 철회할 수 있다.'] },
  { no: 7, title: '반품 비용', paragraphs: ['단순 변심에 의한 반품 비용은 이용자가 부담하고, 상품 하자에 의한 반품 비용은 몰이 부담한다.'] },
  { no: 8, title: '환급', paragraphs: ['몰은 반품된 상품을 받은 날부터 3영업일 이내에 대금을 환급한다.'] },
  { no: 9, title: '개인정보', paragraphs: ['몰은 구매 계약 이행에 필요한 최소한의 개인정보만 수집한다.'] },
  { no: 10, title: '분쟁 해결', paragraphs: ['몰과 이용자 사이의 분쟁은 관계 법령에 따른 분쟁조정기구의 조정에 따를 수 있다.'] },
];

function hwpRecord(tag: number, level: number, payload: Buffer): Buffer {
  const big = payload.length >= 0xfff;
  const h = Buffer.alloc(big ? 8 : 4);
  h.writeUInt32LE((tag | (level << 10) | ((big ? 0xfff : payload.length) << 20)) >>> 0, 0);
  if (big) h.writeUInt32LE(payload.length, 4);
  return Buffer.concat([h, payload]);
}

/** 최소 HWP 5.0 문서(OLE/CFB): FileHeader + DocInfo(문서 속성) + BodyText/Section0(문단 머리·글자·글자 모양).
 *  attrs: bit0 압축, bit1 암호, bit2 배포용. 배포용이면 BodyText 대신 ViewText 를 둔다(hwp.js 가 읽지 못하는 변형) */
export async function buildHwp(paragraphs: string[], attrs = 0x1): Promise<Buffer> {
  const zlib = await import('node:zlib');
  const CFB = (await import('cfb')).default;
  const header = Buffer.alloc(256);
  header.write('HWP Document File', 0, 'latin1');
  Buffer.from([0x00, 0x03, 0x00, 0x05]).copy(header, 32); // 5.0.3.0 (DWORD little-endian)
  header.writeUInt32LE(attrs, 36);
  const props = Buffer.alloc(26);
  props.writeUInt16LE(1, 0); // 구역 수
  props.writeUInt16LE(1, 2);
  const docInfo = zlib.deflateRawSync(hwpRecord(16, 0, props));
  const recs: Buffer[] = [];
  for (const t of paragraphs) {
    const text = Buffer.from(`${t}\r`, 'utf16le');
    const ph = Buffer.alloc(22);
    ph.writeUInt32LE(t.length + 1, 0);
    ph.writeUInt16LE(1, 12); // 글자 모양 수
    recs.push(hwpRecord(66, 0, ph), hwpRecord(67, 1, text), hwpRecord(68, 1, Buffer.alloc(8)));
  }
  const section = Buffer.concat(recs);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, 'FileHeader', header);
  CFB.utils.cfb_add(cfb, 'DocInfo', docInfo);
  if (attrs & 0x4) CFB.utils.cfb_add(cfb, 'ViewText/Section0', crypto.randomBytes(section.length));
  else CFB.utils.cfb_add(cfb, 'BodyText/Section0', attrs & 0x1 ? zlib.deflateRawSync(section) : section);
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }) as Uint8Array);
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** HWPX(OWPML) — ZIP + Contents/section0.xml 의 hp:p 문단 */
export async function buildHwpx(paragraphs: string[]): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file('version.xml', '<?xml version="1.0" encoding="UTF-8"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1"/>');
  zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>');
  zip.file('Contents/content.hpf', '<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="no"/><opf:itemref idref="section0"/></opf:spine></opf:package>');
  zip.file('Contents/header.xml', '<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4" secCnt="1"/>');
  const ps = paragraphs
    .map((t, i) => `<hp:p id="${i}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${xmlEsc(t)}</hp:t></hp:run></hp:p>`)
    .join('');
  zip.file('Contents/section0.xml', `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${ps}</hs:sec>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('docx');
  const doc = new Document({
    sections: [{ children: paragraphs.map((t, i) => new Paragraph(i === 0 ? { heading: HeadingLevel.TITLE, children: [new TextRun(t)] } : { children: [new TextRun(t)] })) }],
  });
  return Packer.toBuffer(doc);
}

/** 조 머리말은 h3, 본문은 p. chrome=true 면 게시 페이지처럼 머리·탐색·바닥글을 두른다(URL 수집용) */
export function buildHtml(title: string, articles: Article[], chrome = false): string {
  const body = articles
    .map((a) => {
      const ps = a.paragraphs.length === 1 ? [a.paragraphs[0]!] : a.paragraphs.map((p, i) => `${CIRCLED[i]} ${p}`);
      return `<h3>제${a.no}조(${xmlEsc(a.title)})</h3>\n${ps.map((p) => `<p>${xmlEsc(p)}</p>`).join('\n')}`;
    })
    .join('\n');
  const article = `<article><h1>${xmlEsc(title)}</h1>\n${body}\n</article>`;
  const main = chrome
    ? `<header><a href="/">가상스터디</a><nav><a href="/courses">강의</a> <a href="/pricing">요금제</a> <a href="/login">로그인</a></nav></header>
<main>${article}</main>
<aside><h4>관련 문서</h4><ul><li><a href="/privacy">개인정보 처리방침</a></li><li><a href="/refund">환불 안내</a></li></ul></aside>
<footer><p>주식회사 가상스터디 · 가상시 가상구 · 고객센터 운영시간 평일 10시~18시</p><p>Copyright 가상스터디. All rights reserved.</p></footer>`
    : article;
  return `<!DOCTYPE html>\n<html lang="ko"><head><meta charset="utf-8"><title>${xmlEsc(title)}</title></head>\n<body>\n${main}\n</body></html>\n`;
}

/** 스캔형 PDF — 본문을 150dpi 이미지로 그려 한 쪽에 한 장씩 넣는다(텍스트 층 없음). degradeFromLine 이후 조 본문 줄은 흐리게 그려 인식 품질을 떨어뜨린다 */
export async function buildScanPdf(file: string, text: string, opts: { degradeFromLine?: string } = {}): Promise<void> {
  const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');
  GlobalFonts.registerFromPath(FONT, 'AppleGothicFx');
  const W = 1240;
  const H = 1754;
  const M = 110;
  const FS = 28;
  const LH = 46;
  const measure = createCanvas(10, 10).getContext('2d');
  measure.font = `${FS}px AppleGothicFx`;
  // 줄 바꿈
  const lines: { s: string; degraded: boolean }[] = [];
  let degraded = false;
  for (const raw of text.split('\n')) {
    if (opts.degradeFromLine && raw.startsWith(opts.degradeFromLine)) degraded = true;
    // 조 머리말은 또렷하게 두고 본문 줄만 흐리게 한다(얼룩진 본문 — 조 구조는 살아 있음)
    const headerLine = /^제\d+조/.test(raw);
    if (!raw) {
      lines.push({ s: '', degraded: false });
      continue;
    }
    let cur = '';
    for (const ch of raw) {
      if (measure.measureText(cur + ch).width > W - 2 * M) {
        lines.push({ s: cur, degraded: degraded && !headerLine });
        cur = ch;
      } else cur += ch;
    }
    if (cur) lines.push({ s: cur, degraded: degraded && !headerLine });
  }
  const perPage = Math.floor((H - 2 * M) / LH);
  const pages: Buffer[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let p = 0; p * perPage < lines.length; p++) {
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.font = `${FS}px AppleGothicFx`;
    ctx.textBaseline = 'top';
    lines.slice(p * perPage, (p + 1) * perPage).forEach((l, i) => {
      const y = M + i * LH;
      if (!l.degraded) {
        ctx.fillStyle = '#111111';
        ctx.fillText(l.s, M, y);
        return;
      }
      // 흐린 인쇄 + 얼룩: 옅은 회색으로 약간 어긋나게 두 번 찍고 점 잡음을 뿌린다
      ctx.fillStyle = '#9a9a9a';
      ctx.fillText(l.s, M, y);
      ctx.fillStyle = 'rgba(150,150,150,0.6)';
      ctx.fillText(l.s, M + 1.5, y + 1);
      for (let k = 0; k < 900; k++) {
        ctx.fillStyle = rnd() < 0.5 ? '#ffffff' : '#8a8a8a';
        ctx.fillRect(M + rnd() * (W - 2 * M), y + rnd() * FS * 1.2, 2, 2);
      }
    });
    pages.push(Buffer.from(await cv.encode('png')));
  }
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    const out = fs.createWriteStream(file);
    doc.pipe(out);
    for (const png of pages) {
      doc.addPage({ size: 'A4', margin: 0 });
      doc.image(png, 0, 0, { width: 595.28, height: 841.89 });
    }
    doc.end();
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
}

/** 문단 목록 — 첫 줄 = 제목, 조 머리말과 항은 각각 한 문단(HWP·HWPX·DOCX 공통) */
function articleParagraphs(title: string, articles: Article[]): string[] {
  return articlesToText(title, articles).split('\n').filter(Boolean);
}

export async function buildFormatFixtures(): Promise<void> {
  const dir = path.join(FX, 'contracts', 'formats');
  fs.mkdirSync(dir, { recursive: true });
  const paras = articleParagraphs(SUB_TITLE, SUBSCRIPTION_ARTICLES);
  const text = articlesToText(SUB_TITLE, SUBSCRIPTION_ARTICLES);
  fs.writeFileSync(path.join(dir, 'subscription-sample.hwp'), await buildHwp(paras));
  fs.writeFileSync(path.join(dir, 'variant-distribution.hwp'), await buildHwp(paras, 0x1 | 0x4));
  fs.writeFileSync(path.join(dir, 'encrypted.hwp'), await buildHwp(paras, 0x1 | 0x2));
  fs.writeFileSync(path.join(dir, 'subscription-sample.hwpx'), await buildHwpx(paras));
  fs.writeFileSync(path.join(dir, 'subscription-sample.docx'), await buildDocx(paras));
  fs.writeFileSync(path.join(dir, 'subscription-sample.html'), buildHtml(SUB_TITLE, SUBSCRIPTION_ARTICLES));
  fs.writeFileSync(path.join(dir, 'terms-page.html'), buildHtml(SUB_TITLE, SUBSCRIPTION_ARTICLES, true));
  await buildScanPdf(path.join(dir, 'subscription-sample-scan.pdf'), text, { degradeFromLine: '제38조' });
  // 두 약관 결합 — 첫 약관 끝에 부칙(제1조 재시작이지만 나누지 않음), 이어서 둘째 약관 제목이 다시 나온다(UC1 A5)
  const combined = [text, '부칙', '제1조(시행일) 이 약관은 2026년 9월 1일부터 시행한다.', articlesToText('가상마켓 쇼핑몰 이용약관', SHOP_ARTICLES)].join('\n');
  await writePdf(path.join(dir, 'combined-two.pdf'), combined);
}

async function main() {
  if (process.argv.includes('formats')) {
    await buildFormatFixtures();
    process.stdout.write(`format fixtures written to ${path.join(FX, 'contracts', 'formats')}\n`);
    return;
  }
  fs.mkdirSync(path.join(FX, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(FX, 'non-contract'), { recursive: true });
  const text = articlesToText('가상스터디 온라인 강의 구독 서비스 이용약관', SUBSCRIPTION_ARTICLES);
  fs.writeFileSync(path.join(FX, 'contracts', 'subscription-sample.txt'), text);
  await writePdf(path.join(FX, 'contracts', 'subscription-sample.pdf'), text);
  fs.writeFileSync(path.join(FX, 'contracts', 'subscription-sample.labels.json'), JSON.stringify(SUBSCRIPTION_LABELS, null, 1));
  await writePdf(path.join(FX, 'non-contract', 'receipt.pdf'), RECEIPT_TEXT);
  await writePdf(path.join(FX, 'contracts', 'encrypted.pdf'), '암호가 걸린 계약서입니다.', { userPassword: 'fixture-pass' }); // 테스트 픽스처(암호 PDF) secrets-scan:allow
  await writePdf(path.join(FX, 'contracts', 'pages-301.pdf'), '쪽수 한도 확인용', { pages: 301 });
  await buildPiiFixtures();
  const extra = (await import('./build-fixtures-extra.js').catch(() => null)) as { buildExtra?: () => Promise<void> } | null;
  if (extra?.buildExtra) await extra.buildExtra();
  await buildFormatFixtures();
  process.stdout.write(`fixtures written to ${FX}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) void main();
