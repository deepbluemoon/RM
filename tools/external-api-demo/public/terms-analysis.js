// [실제 기능] 회원가입 화면의 「AI 약관 위험 분석」 — 유클마켓이 계약위험탐지 공개 API 를 붙인 부분.
//  - 자동 분석(즉시 표시): 화면을 열면 버튼 없이 POST /v1/jobs + GET /v1/jobs/{id}(M1 편법 · M2 위법) → 가입 창 안에 바로 보인다
//  - 상세 이유·근거(요청 시): 카드의 [이유·근거 보기]를 누른 조항만 POST /v1/judge(M3). 결과는 페이지 안에서 캐시한다
//  - 근거는 서버가 지식 DB 에서 검색해 넣는다(evidence 를 보내지 않음, 2026-10-01). 화면에는 응답 evidence 중 AI가 인용한 것(cited)만, M2 related_laws(값이 있을 때)
// 결과는 모두 API 응답 그대로이며 mock 이 없다. 호출은 crd-client.js → 업체 서버(server.mjs, 키 보관) → https://p2.sumzip.com/api/model
import { detectJob, judge, healthCached, splitClauses, friendlyError, EVIDENCE, plainFor, displayTitle, safeUrl, TYPE_KO, CLASS_KO, LEVEL_KO, CONFIDENCE_KO, RISK_SYMBOL } from './crd-client.js';

// 업체(유클마켓)가 정한 연동 설정
const PARTNER = {
  contractType: 'ecommerce',   // 쇼핑몰 이용약관
  perspective: 'consumer',     // 가입하는 사람 = 소비자
  // 「확인이 필요한 조항」으로 보여 줄 기준. API 의 label 기준은 0.5, M2 단독 표시는 0.8 이상만 쓴다. 모든 점수는 「전체 조항 점수」에 그대로 보인다.
  // 약관 2판(16조, 2026-10-01)은 ordneg 모델로 재어 문제 8 전부 표시·정상 8 전부 미표시를 확인했다(README 「표시 기준」). 모델이 바뀌면 다시 잴 것
  showIfLoophole: 0.5,
  showIfIllegal: 0.8,
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const level = (s) => (s >= 0.8 ? 'hi' : s >= 0.5 ? 'mid' : 'ok');
const LEVEL_TXT = { hi: '높음', mid: '주의', ok: '낮음' };
const CLASS_LEVEL = { illegal: 'hi', unfair: 'hi', dispute: 'mid', normal: 'ok' };
const EV_BY_ID = Object.fromEntries(EVIDENCE.map((e) => [e.id, e]));
const SOURCE_KO = { law_article: '법령', ftc_case: '공정위 사례', std_terms: '표준약관' };
/** 회피형 모델 유형 → 화면 이름. 'other'·없음은 null(지금 서빙 모델은 유형을 내지 않아 전부 other) */
const typeName = (t) => (t && t !== 'other' ? TYPE_KO[t] || null : null);

const termsBox = $('#termsBox'), box = $('#aiResult');
let clauses = [];
let rows = [];   // 자동 분석 결과(조항별)
let pRows = [];  // 개인정보 동의 시험 분석 결과

// ─── 약관 불러오기 · 표시(보기 버튼으로 펼침) ───
async function loadTerms() {
  const text = await (await fetch('/euclmarket-terms.txt')).text();
  clauses = splitClauses(text);
  const byArticle = Object.fromEntries(clauses.map((c) => [c.article_no, c.clause_id]));
  termsBox.innerHTML = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).map((line, i) => {
    if (i === 0) return `<h4>${esc(line)}</h4>`;
    if (/^제\s*\d+\s*장|^부\s*칙/.test(line)) return `<h5>${esc(line)}</h5>`;
    const m = /^제\s*(\d+)\s*조/.exec(line);
    const id = m && byArticle[`제${m[1]}조`];
    return `<p${id ? ` id="term-${id}"` : ''}>${esc(line)}</p>`;
  }).join('');
}
function showTerms(open) {
  termsBox.hidden = !open;
  termsBox.parentElement.hidden = !open;
  $('#btnTermsToggle').setAttribute('aria-expanded', String(open));
  $('#btnTermsToggle').textContent = open ? '접기' : '보기';
}
$('#btnTermsToggle').addEventListener('click', () => showTerms(termsBox.hidden));

// ─── 상단 요약 배너 — 가입 카드 위에서 결과를 먼저 알리고, 누르면 결과로 이동 ───
const bannerEl = $('#aiBanner');
function banner(html, tone, withGo, hide = false) {
  if (!bannerEl) return;
  bannerEl.hidden = hide;
  if (hide) return;
  bannerEl.className = `ai-banner ${tone}`;
  bannerEl.innerHTML = `${LOGO}<span class="txt">${html}</span>${withGo ? '<button type="button" class="go" data-go-result>결과 보기</button>' : ''}`;
}
bannerEl?.addEventListener('click', (e) => {
  if (!e.target.closest('[data-go-result]')) return;
  box.scrollIntoView({ block: 'start' });
  box.querySelector('summary')?.focus({ preventScroll: true });
});

// ─── 자동 분석 ───
const LOGO = '<span class="readme-logo" role="img" aria-label="ReadMe"></span>';
const HEAD = `<h2 class="ai-head">${LOGO}<span class="by">약관 위험 분석</span></h2>`;

async function analyze() {
  banner('ReadMe가 이용약관을 읽고 있어요…', '', false);
  box.innerHTML = `${HEAD}<div class="ai-load"><span class="spin"></span><span>ReadMe가 이용약관 ${clauses.length}개 조항을 읽고 있어요…</span></div>`;
  try {
    const job = await detectJob(PARTNER.contractType, clauses);
    render(job);
  } catch (e) {
    banner('', '', false, true);
    box.innerHTML = `${HEAD}<div class="err">${esc(friendlyError(e))} <button type="button" class="linkbtn" data-retry>다시 시도</button></div>`;
    console.warn('[AI 약관 분석]', e.message);
  }
}

function render(job) {
  const byId = Object.fromEntries(clauses.map((c) => [c.clause_id, c]));
  rows = (job.results || []).map((r) => {
    const c = byId[r.clause_id] || {};
    const lo = r.loophole?.score ?? 0, il = r.illegal?.score ?? 0;
    return { ...r, c, lo, il, show: !r.error && (lo >= PARTNER.showIfLoophole || il >= PARTNER.showIfIllegal), lvl: level(Math.max(lo, il)) };
  });
  const risky = rows.filter((r) => r.show).sort((a, b) => Math.max(b.lo, b.il) - Math.max(a.lo, a.il));

  // 약관 본문(보기)에도 표시
  for (const r of risky) {
    const p = document.getElementById(`term-${r.clause_id}`);
    if (!p) continue;
    p.classList.add(r.lvl === 'hi' ? 'risk-hi' : 'risk-mid');
    const tag = document.createElement('span');
    const tn = typeName(r.loophole?.type);
    tag.className = 'tag'; tag.textContent = tn ? `ReadMe 확인 필요 · ${tn}` : 'ReadMe 확인 필요';
    p.append(tag);
  }

  const n = risky.length, hi = risky.filter((r) => r.lvl === 'hi').length;
  const safe = rows.filter((r) => !r.show && !r.error);
  const types = [...new Set(risky.map((r) => typeName(r.loophole?.type)).filter(Boolean))].slice(0, 3);
    box.innerHTML = `${HEAD}
    <div class="verdict ${!n ? 'ok' : hi ? 'hi' : 'mid'}">
      <div class="big">${n ? `동의 전에 확인이 필요한 조항 ${n}개가 있어요` : '눈에 띄는 위험 조항을 찾지 못했어요'}</div>
      <p>${n ? `${types.length ? `주로 ${types.join(' · ')} 관련이에요. ` : ''}조항을 누르면 내용과 이유를 볼 수 있어요.` : '그래도 약관은 직접 한 번 읽어 보시길 권해요.'}</p>
      <div class="kpis"><div>읽은 조항<b>${rows.length}</b></div><div>확인 필요<b>${n}</b></div><div>문제 소지 낮음<b>${safe.length}</b></div></div>
    </div>
    ${risky.map(card).join('')}
    ${safe.length ? `<details class="safe-list"><summary><span class="chip ok">○ 문제 소지 낮음</span> 조항 ${safe.length}개 보기</summary>
      <ul>${safe.map((r) => `<li><b>${esc(r.c.article_no || '')} ${esc(r.c.title || '')}</b><span class="src">회피형 ${r.lo.toFixed(2)} · 위법형 ${r.il.toFixed(2)}</span><button type="button" class="linkbtn" data-jump="${esc(r.clause_id)}">약관에서 보기</button></li>`).join('')}</ul>
      <p class="disclaimer" style="margin:6px 0 0">탐지 점수가 기준(회피형 ${PARTNER.showIfLoophole} · 위법형 ${PARTNER.showIfIllegal}) 아래라 따로 확인할 필요가 낮은 조항이에요.</p></details>` : ''}
    <details class="all"><summary>전체 조항 점수 보기 (${rows.length}개)</summary>
      <table class="tbl"><thead><tr><th>조항</th><th>회피형</th><th>위법형</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.c.article_no || r.clause_id)} ${esc(r.c.title || '')}</td><td>${r.error ? '-' : r.lo.toFixed(2)}</td><td>${r.error ? '-' : r.il.toFixed(2)}</td><td>${r.error ? '판단 어려움' : r.show ? '확인 필요' : ''}</td></tr>`).join('')}
      </tbody></table>
      <p class="disclaimer" style="margin-top:8px">점수는 0~1, 높을수록 위험 소지가 커요. 「확인 필요」 기준: 회피형 ${PARTNER.showIfLoophole} 이상 또는 위법형 ${PARTNER.showIfIllegal} 이상.</p>
    </details>
    <p class="disclaimer">ReadMe가 약관 문구를 읽고 알려 드리는 참고 정보이며, 법률 자문이 아니에요.</p>`;
  banner(n ? `이 약관에서 <b>확인이 필요한 조항 ${n}개</b>를 찾았어요` : '눈에 띄는 위험 조항을 찾지 못했어요', '', true);
}

function meter(label, score, what) {
  const l = level(score);
  return `<div class="meter"><div class="lbl"><span>${label}</span><b>${score.toFixed(2)}</b></div><div class="track"><i class="${l}" style="width:${Math.round(score * 100)}%"></i></div><span class="what">${esc(what)}</span></div>`;
}
function card(r) {
  const lo = r.loophole || {}, il = r.illegal || {};
  const loWhat = lo.label === 'loophole' ? typeName(lo.type) || '회피 소지 있음' : '해당 없음';
  const laws = (il.related_laws || []).filter(Boolean);
  const ilWhat = il.label !== 'illegal' ? '해당 없음' : laws.length ? `관련 법: ${laws.join(', ')}` : '위법 소지 있음';
  // 접힌 상태가 기본 — 조 이름과 위험 등급만 보이고, 누르면 원문·점수·이유 보기가 펼쳐진다
  return `<details class="risk" id="risk-${esc(r.clause_id)}">
    <summary class="risk-top"><h3>${esc(r.c.article_no || '')} ${esc(r.c.title || '')}</h3><span class="chip ${r.lvl}" title="탐지 점수로 고른 조항이에요. 이유를 보면 ReadMe 판단으로 바뀌어요">확인 필요</span><span class="chev" aria-hidden="true"></span></summary>
    <div class="risk-body">
      <blockquote>${esc(r.c.text)}</blockquote>
      <div class="meters">${meter('회피형 탐지 점수', r.lo, loWhat)}${meter('위법형 탐지 점수', r.il, ilWhat)}</div>
      <div class="risk-actions"><button type="button" class="btn-why" data-why="${esc(r.clause_id)}" aria-expanded="false">이유·근거 보기</button><button type="button" class="linkbtn" data-jump="${esc(r.clause_id)}">${r.clause_id.startsWith('p') ? '동의서에서 보기' : '약관에서 보기'}</button></div>
      <div class="why" data-why-box hidden></div>
    </div>
  </details>`;
}

// ─── 이유·근거 보기(요청 시 /v1/judge, 캐시) ───
const judgeCache = new Map();   // clause_id → Promise<judge 응답>. 실패하면 지워서 다시 시도할 수 있게
let queue = Promise.resolve();  // 공유 모델이라 동시에 1건만 — 여러 개를 눌러도 순서대로
function judgeOnce(r) {
  if (!judgeCache.has(r.clause_id)) {
    const scores = {};
    if (r.loophole) scores.loophole = r.lo;
    if (r.illegal) scores.illegal = r.il;
    const p = queue.then(() => judge({ clause: r.c.text, contractType: PARTNER.contractType, perspective: PARTNER.perspective, scores }));
    queue = p.catch(() => {});
    p.catch(() => judgeCache.delete(r.clause_id));
    judgeCache.set(r.clause_id, p);
  }
  return judgeCache.get(r.clause_id);
}

// 설명 문장에서 강조할 어절 — 위험·불이익을 말하는 말만 색을 바꾼다(주제어 청약철회·환불·해지·위약금·손해·관할은 칠하지 않음).
// 두 어절에 걸친 말(사전 공지 없이 · 책임을 지지)은 이어서 칠한다. 글자는 API 응답 그대로(esc 후 감싸기만)
const EMPH = /(제한|배제|불리|부당|과도|과중|일방|무효|침해|불편|초래|포기|면책|불가|불공정|위반|불이익|소멸|전액|에만)/;
const EMPH_PAIRS = [[/^(사전|미리)$/, /^(공지|안내|통지|고지|동의)/], [/^(공지|안내|통지|고지|동의)$/, /^없이/], [/^책임을?$/, /^(지지|없)/], [/^지지$/, /^않/]];
function emphasize(text) {
  const parts = String(text ?? '').split(/(\s+)/);
  const words = parts.map((w, i) => ({ w, i })).filter((x) => !/^\s*$/.test(x.w));
  const hit = new Set(words.filter((x) => EMPH.test(x.w)).map((x) => x.i));
  for (let k = 0; k + 1 < words.length; k++) {
    for (const [p1, p2] of EMPH_PAIRS) {
      if (p1.test(words[k].w) && p2.test(words[k + 1].w)) { hit.add(words[k].i); hit.add(words[k + 1].i); }
    }
  }
  // 칠한 어절 사이의 공백도 함께 감싸 한 덩어리로 보이게
  return parts.map((w, i) => (hit.has(i) || (/^\s+$/.test(w) && hit.has(i - 1) && hit.has(i + 1)) ? `<mark class="em">${esc(w)}</mark>` : esc(w))).join('');
}

// 근거 본문의 파란색 = AI 설명에서 빨간색으로 표시한 핵심어(EMPH·EMPH_PAIRS)와 같은 말이 들어간 어절. 빨강 ↔ 파랑이 짝을 이룬다
const KEY_SKIP = new Set(['에만']);   // 너무 흔해 근거에서 짝으로 쓰기 어려운 것
/** 설명에서 빨간색이 된 핵심어(한 어절 뿌리)와, 두 어절 표현 규칙(사전 공지 없이·책임을 지지 …) 중 설명에 실제로 쓰인 것 */
function claimKeys(claims) {
  const roots = new Set(), pairs = new Set();
  for (const c of claims) {
    for (const m of String(c ?? '').matchAll(new RegExp(EMPH.source, 'g'))) if (!KEY_SKIP.has(m[1])) roots.add(m[1]);
    const ws = String(c ?? '').split(/\s+/).filter(Boolean);
    for (let k = 0; k + 1 < ws.length; k++) EMPH_PAIRS.forEach((pr, i) => { if (pr[0].test(ws[k]) && pr[1].test(ws[k + 1])) pairs.add(i); });
  }
  return { roots: [...roots], pairs: [...pairs].map((i) => EMPH_PAIRS[i]) };
}
function markMatches(text, claims) {
  const { roots, pairs } = claimKeys(claims);
  if (!roots.length && !pairs.length) return esc(text);
  const parts = String(text ?? '').split(/(\s+)/);
  const idx = parts.map((w, i) => i).filter((i) => !/^\s*$/.test(parts[i]));
  const hit = new Set(idx.filter((i) => roots.some((k) => parts[i].includes(k))));
  for (let k = 0; k + 1 < idx.length; k++) {   // 두 어절 표현은 두 어절이 함께 있을 때만(「공지합니다」처럼 반대 뜻에 칠하지 않게)
    for (const [p1, p2] of pairs) if (p1.test(parts[idx[k]]) && p2.test(parts[idx[k + 1]])) { hit.add(idx[k]); hit.add(idx[k + 1]); }
  }
  return parts.map((w, i) => (hit.has(i) ? `<mark class="match">${esc(w)}</mark>` : esc(w))).join('');
}

function whyHtml(r, d) {
  const lvl = CLASS_LEVEL[d.risk_class] || 'mid';
  const items = d.explanation || [];
  // 응답이 인용한 근거만 — 서버 검색이면 응답 evidence 의 cited, 직접 보낸 근거면 evidence_ids 로 찾는다
  const cited = Array.isArray(d.evidence)
    ? d.evidence.filter((e) => e.cited)
    : [...new Set(items.flatMap((x) => x.evidence_ids || []))].map((id) => EV_BY_ID[id]).filter(Boolean);
  const laws = (r.illegal?.related_laws || []).filter(Boolean);
  const meta = [
    d.risk_level && `위험도 ${RISK_SYMBOL[d.risk_level] || ''}${LEVEL_KO[d.risk_level] || d.risk_level}`,
    d.confidence && `확신 ${CONFIDENCE_KO[d.confidence] || d.confidence}`,
    typeName(d.risk_type),
  ].filter(Boolean);
  const head = `ReadMe는 이 조항을 <span class="chip ${lvl}">${esc(CLASS_KO[d.risk_class] || d.risk_class)}</span> 으로 봤어요` +
    (meta.length ? ` <span class="src">(${esc(meta.join(' · '))})</span>` : '');
  const reasons = items.length
    ? `<ul>${items.map((x) => `<li>${emphasize(x.claim)}</li>`).join('')}</ul>`
    : '<p class="src" style="margin:0">근거와 맞는 설명을 만들지 못했어요. 위 점수와 조항 원문을 참고해 주세요.</p>';
  const plains = cited.map((e) => ({ e, text: plainFor(e) })).filter((x) => x.text);
  const ev = cited.length || laws.length ? `<div class="ev"><div class="ev-h">ReadMe가 인용한 근거</div>
      ${cited.map((e) => `<div class="ev-item"><b>${esc(SOURCE_KO[e.source_type] || '근거')} · ${esc(displayTitle(e.title))}</b><span>${markMatches(e.text, items.map((x) => x.claim))}</span>${safeUrl(e.source_url) ? `<button type="button" class="btn-src" data-src="${esc(e.source_url)}" data-src-type="${esc(e.source_type)}" data-src-title="${esc(displayTitle(e.title))}">원문 보기</button>` : ''}</div>`).join('')}
      ${laws.length ? `<div class="ev-item"><b>위법형 탐지 모델이 짚은 관련 법</b><span>${esc(laws.join(', '))}</span></div>` : ''}
      ${plains.length ? `<div class="plains"><div class="h">쉽게 말하면</div>${plains.map((x) => `<p>${plains.length > 1 ? `<b>${esc(displayTitle(x.e.title))}</b> — ` : ''}${esc(x.text)}</p>`).join('')}</div>` : ''}
    </div>` : '';
  return `<div class="lead">${head}</div>${reasons}${ev}
    <div class="note">근거는 계약위험탐지 지식 DB${d.knowledge_date ? `(기준일 ${esc(d.knowledge_date)})` : ''}에서 찾은 것 중 ReadMe가 설명에서 직접 인용한 것만 보여요. 참고 정보이며 법률 자문이 아니에요.</div>`;
}

// 카드 등급 = 처음엔 탐지 점수(위험 높음·주의), 이유를 받은 뒤엔 판단 결과(불공정 가능성 등)로 바꾼다
function syncGrade(r, d) {
  const lvl = CLASS_LEVEL[d.risk_class] || r.lvl;
  const chip = document.querySelector(`#risk-${CSS.escape(r.clause_id)} .risk-top .chip`);
  if (chip) { chip.className = `chip ${lvl}`; chip.textContent = `${CLASS_KO[d.risk_class] || chip.textContent}${d.risk_level ? ` · ${RISK_SYMBOL[d.risk_level] || ''}${LEVEL_KO[d.risk_level] || ''}` : ''}`; chip.title = 'ReadMe 판단 결과(위험도)'; }
  const p = document.getElementById(`term-${r.clause_id}`);
  if (p) { p.classList.remove('risk-hi', 'risk-mid'); if (lvl !== 'ok') p.classList.add(lvl === 'hi' ? 'risk-hi' : 'risk-mid'); }
}

async function toggleWhy(btn) {
  const r = [...rows, ...pRows].find((x) => x.clause_id === btn.dataset.why);
  const why = btn.closest('.risk').querySelector('[data-why-box]');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? '이유·근거 접기' : '이유·근거 보기';
  why.hidden = !open;
  if (!open || why.dataset.loaded) return;
  // 기다림 안내 — 본 서비스 진행 줄(ProgressWaitLine)과 같은 방식: 지난 시간(mm:ss) + 보통 걸리는 시간 + 준비·대기 안내.
  // API 는 판단에 걸릴 시간을 주지 않는다 — 준비 시간(warmup_estimate_sec)과 대기 수(queue_depth)만 /health 에 있다(60초 캐시)
  why.innerHTML = `<div class="why-load"><span class="spin sm"></span><span>ReadMe가 이유를 정리하고 있어요</span>
    <span class="wait-note">지난 시간 <span class="clock" aria-live="off">0:00</span><span class="notice"></span> · 보통 2~5초 걸려요</span></div>`;
  const t0 = Date.now();
  const clock = why.querySelector('.clock');
  const tick = setInterval(() => {
    if (!why.querySelector('.why-load')) return clearInterval(tick);
    const sec = Math.floor((Date.now() - t0) / 1000);
    clock.textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }, 1000);
  if (!judgeCache.has(r.clause_id)) {
    healthCached().then((h) => {
      const slot = why.querySelector('.why-load .notice');
      if (!h || !slot) return;
      const m3 = (h.models || []).find((m) => m.id === 'M3');
      const notes = [];
      if (m3 && m3.state !== 'ready') notes.push(`설명을 준비하고 있어요${h.warmup_estimate_sec ? ` 약 ${h.warmup_estimate_sec}초 더 걸려요` : ''}`);
      if (h.queue_depth > 0) notes.push('앞선 요청이 끝나기를 기다리고 있어요');
      if (notes.length) slot.innerHTML = ` · <b>${esc(notes.join(' · '))}</b>`;
    });
  }
  try {
    const d = await judgeOnce(r);
    clearInterval(tick);
    why.innerHTML = whyHtml(r, d);
    why.dataset.loaded = '1';
    syncGrade(r, d);
  } catch (e) {
    why.innerHTML = `<span class="src">${esc(friendlyError(e))}</span> <button type="button" class="linkbtn" data-rewhy="${esc(r.clause_id)}">다시 시도</button>`;
  }
}

// ─── 이벤트 ───
function onResultClick(e) {
  const t = e.target;
  if (t.closest('[data-retry]')) return analyze();
  const w = t.closest('[data-why]');
  if (w) return toggleWhy(w);
  const rw = t.closest('[data-rewhy]');
  if (rw) {
    const btn = document.querySelector(`[data-why="${CSS.escape(rw.dataset.rewhy)}"]`);
    btn.setAttribute('aria-expanded', 'false');
    return toggleWhy(btn);
  }
  const sb = t.closest('[data-src]');
  if (sb) return openSource(sb);
  const j = t.closest('[data-jump]');
  if (j) {
    const isPrivacy = j.dataset.jump.startsWith('p');
    if (isPrivacy) showPrivacy(true); else showTerms(true);
    const p = document.getElementById(`term-${j.dataset.jump}`);
    if (!p) return;
    p.scrollIntoView({ block: 'center' });
    p.classList.add('flash'); setTimeout(() => p.classList.remove('flash'), 1600);
  }
}
box.addEventListener('click', onResultClick);

// ─── 근거 원문 옆 창 — 법령·표준약관(law.go.kr)은 옆에 띄우고, 공정위 사례는 보도자료 파일(한글)이라 받기 안내만 ───
const srcPanel = $('#srcPanel');
let srcOpener = null;
function openSource(btn) {
  const url = safeUrl(btn.dataset.src);
  if (!url) return;
  srcOpener = btn;
  $('#srcTitle').textContent = btn.dataset.srcTitle || '근거 원문';
  $('#srcNewTab').href = url;
  const body = $('#srcBody');
  if (btn.dataset.srcType === 'ftc_case') {
    $('#srcNewTab').hidden = true;
    $('#srcZoom').hidden = true;
    body.innerHTML = `<div class="src-note"><p>공정위 사례 원문은 공정거래위원회 보도자료 파일(한글 hwp)이라 화면 안에서 바로 보여 드릴 수 없어요.</p><p><a href="${esc(url)}" rel="noopener">보도자료 파일 받기</a></p></div>`;
  } else {
    $('#srcNewTab').hidden = false;
    $('#srcZoom').hidden = false;
    body.innerHTML = `<div class="frame-wrap"><iframe title="${esc(btn.dataset.srcTitle || '근거 원문')}" src="${esc(url)}" referrerpolicy="no-referrer"></iframe></div>`;
  }
  srcPanel.hidden = false;
  $('#srcClose').focus();
}
function closeSource() {
  if (srcPanel.hidden) return;
  srcPanel.hidden = true;
  $('#srcBody').innerHTML = '';
  srcOpener?.focus();
}
$('#srcClose').addEventListener('click', closeSource);
// 원문 창 확대·축소 — 다른 사이트(law.go.kr) 화면은 우리가 스크롤을 바꿀 수 없어서, 창 안 화면을 통째로 줄이고 늘린다(70~130%)
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
let zoom = Number(store.get('demo-src-zoom')) || 1;
function applyZoom() {
  zoom = Math.min(1.3, Math.max(0.7, Math.round(zoom * 10) / 10));
  srcPanel.style.setProperty('--z', zoom);
  $('#srcZoomVal').textContent = `${Math.round(zoom * 100)}%`;
  store.set('demo-src-zoom', zoom);
}
$('#srcZoom').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) { zoom += 0.1 * Number(b.dataset.z); applyZoom(); } });
applyZoom();
// 원문 창 너비 — 왼쪽 가장자리를 끌거나 좌우 방향키로(380px ~ 화면 폭 90%)
const MIN_W = 380;
function setWidth(w) {
  const max = Math.round(innerWidth * 0.9);
  const v = Math.min(max, Math.max(MIN_W, Math.round(w)));
  srcPanel.style.setProperty('--src-w', `${v}px`);
  store.set('demo-src-w', v);
}
if (store.get('demo-src-w')) setWidth(Number(store.get('demo-src-w')));
const handle = $('#srcResize');
handle.addEventListener('pointerdown', (e) => {
  e.preventDefault(); handle.setPointerCapture(e.pointerId); srcPanel.classList.add('dragging');
  const move = (ev) => setWidth(innerWidth - ev.clientX);
  const up = () => { srcPanel.classList.remove('dragging'); handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
});
handle.addEventListener('keydown', (e) => {
  const w = srcPanel.getBoundingClientRect().width;
  if (e.key === 'ArrowLeft') { setWidth(w + 40); e.preventDefault(); }
  if (e.key === 'ArrowRight') { setWidth(w - 40); e.preventDefault(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSource(); });

// ─── 개인정보 수집·이용 동의 — 시험 기능 ───
// 탐지·판단 모델은 소비자 약관(약관법·전자상거래법) 사례로 학습했고 근거 DB 에 개인정보보호법이 없다 → 「시험 기능」으로 표시.
// 2026-10-01 실측: 수집 항목(정상) = 문제 소지 낮음 ✓, 보유 기간(탈퇴 후 무기한 보관) = 확인 필요 ✓, 동의 거부 권리(정상) = 확인 필요 ✗(오탐)
const privacyBox = $('#privacyBox'), pBox = $('#aiPrivacy');
let pClauses = [];
function showPrivacy(open) {
  privacyBox.hidden = !open;
  $('#btnPrivacyToggle').setAttribute('aria-expanded', String(open));
  $('#btnPrivacyToggle').textContent = open ? '접기' : '보기';
}
$('#btnPrivacyToggle')?.addEventListener('click', () => showPrivacy(privacyBox.hidden));
async function loadPrivacy() {
  const text = await (await fetch('/euclmarket-privacy.txt')).text();
  const items = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('|'));
  pClauses = items.map(([title, body], i) => ({ clause_id: `p${i + 1}`, title: title.trim(), text: (body || '').trim() }));
  privacyBox.innerHTML = '<h4>유클마켓 개인정보 수집·이용 동의</h4>' + pClauses.map((c) => `<p id="term-${c.clause_id}"><b>${esc(c.title)}</b> · ${esc(c.text)}</p>`).join('');
}
const P_HEAD = `<div class="mini-head">${LOGO}<span>개인정보 동의 분석</span><span class="beta">시험 기능</span></div>
  <p class="mini-note">개인정보 동의서는 아직 정식 분석 범위가 아니라서, 정상 항목도 확인 필요로 나올 수 있어요.</p>`;
async function analyzePrivacy() {
  if (!pBox) return;
  pBox.innerHTML = `${P_HEAD}<div class="ai-load"><span class="spin"></span><span>개인정보 동의 ${pClauses.length}개 항목을 읽고 있어요…</span></div>`;
  try {
    const job = await detectJob(PARTNER.contractType, pClauses);
    const byId = Object.fromEntries(pClauses.map((c) => [c.clause_id, c]));
    pRows = (job.results || []).map((r) => {
      const c = byId[r.clause_id] || {};
      const lo = r.loophole?.score ?? 0, il = r.illegal?.score ?? 0;
      return { ...r, c, lo, il, show: !r.error && (lo >= PARTNER.showIfLoophole || il >= PARTNER.showIfIllegal), lvl: level(Math.max(lo, il)) };
    });
    const risky = pRows.filter((r) => r.show), safe = pRows.filter((r) => !r.show && !r.error);
    pBox.innerHTML = P_HEAD + risky.map(card).join('') +
      safe.map((r) => `<div class="mini-safe"><span class="chip ok">○ 문제 소지 낮음</span><b>${esc(r.c.title)}</b><span class="src">회피형 ${r.lo.toFixed(2)} · 위법형 ${r.il.toFixed(2)}</span></div>`).join('');
  } catch (e) {
    pBox.innerHTML = `${P_HEAD}<div class="err">${esc(friendlyError(e))}</div>`;
  }
}
pBox?.addEventListener('click', onResultClick);

// 화면을 열면 바로 분석
const mainDone = loadTerms().then(analyze).catch(() => {
  box.innerHTML = `${HEAD}<div class="err">약관을 불러오지 못했어요. 새로고침해 주세요.</div>`;
});
// 개인정보 동의 시험 분석은 약관 분석이 끝난 뒤에(공유 서버 순서 · 호출 한도) — 실패해도 약관 결과에는 영향 없음
mainDone.then(loadPrivacy).then(analyzePrivacy).catch(() => { if (pBox) pBox.innerHTML = `${P_HEAD}<div class="err">개인정보 동의 내용을 불러오지 못했어요.</div>`; });
