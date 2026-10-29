// 개발자용 보조 화면 스크립트 — API 콘솔 · 연동 가이드 · 호출 기록. 실제 호출은 crd-client.js(업체 서버 경유, 브라우저에 키 없음)
import { call, onApiCall } from './crd-client.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let CFG = { apiBase: 'https://p2.sumzip.com/api/model', keyConfigured: false };

// ─── 탭 ───
document.querySelectorAll('[role=tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
}));

// ─── 호출 기록 ───
const logEl = $('#log');
onApiCall(({ method, path, status, ms, rateLimit }) => {
  if (logEl.querySelector('.muted')) logEl.innerHTML = '';
  const d = document.createElement('div');
  const cls = status >= 500 || status === 0 ? 'st5' : status >= 400 ? 'st4' : 'st2';
  const remain = /remaining=(\d+)/.exec(rateLimit || '')?.[1];
  d.innerHTML = `<span class="muted">${new Date().toLocaleTimeString('ko-KR')}</span><b class="${cls}">${status || 'ERR'}</b><span>${esc(method)} ${esc(path)}</span><span class="muted">${ms ?? '-'}ms</span>${remain ? `<span class="muted">남은 한도 ${remain}/60</span>` : ''}`;
  logEl.prepend(d);
});

// ─── API 콘솔 ───
const S1 = { contract_type: 'subscription', clauses: [
  { clause_id: 'c1', title: '환불', text: '구매한 이용권은 어떠한 경우에도 환불되지 않습니다.' },
  { clause_id: 'c2', text: '회원은 회원정보가 변경된 경우 지체 없이 수정하여야 합니다.' } ] };
const EPS = [
  { m: 'GET', p: '/health', t: '서버 상태', d: '서버·모델 상태, 대기 수(queue_depth), 준비 예상 시간(warmup_estimate_sec). 적재 중·저하 시 503.' },
  { m: 'GET', p: '/v1/models', t: '모델 버전', d: '모델 이름·버전. 결과를 저장할 때 model_version 을 함께 저장합니다.' },
  { m: 'POST', p: '/v1/detect/loophole', t: '편법 탐지 (M1)', d: '조항별 { label: loophole|none, type, score }. score ≥ 0.5 이면 loophole.', b: S1 },
  { m: 'POST', p: '/v1/detect/illegal', t: '위법 탐지 (M2)', d: '조항별 { label: illegal|none, type, related_laws[], score }.', b: S1 },
  { m: 'POST', p: '/v1/jobs', t: '비동기 작업 만들기', d: '문서 전체(수십~수천 조항)를 M1·M2 로 함께 돌립니다. 202 { job_id } — 받은 id 는 아래 조회에 자동으로 채워집니다.', b: S1 },
  { m: 'GET', p: '/v1/jobs/{job_id}', t: '작업 조회', d: 'status: queued → running → done | failed, done/total 로 진행률. 작업은 1시간 뒤 사라집니다.', job: true },
  { m: 'POST', p: '/v1/judge', t: '최종 판단 (M3)', d: '조항 1건 + M1·M2 점수 → risk_class·risk_level·설명(근거 ID 인용). evidence 를 빼면 서버가 지식 DB 에서 근거를 찾아 넣고 응답 evidence(cited)로 돌려준다. 직접 보내면(최대 10개) 그것만 쓴다. 한 번에 1건.', b: { clause: '구매한 이용권은 어떠한 경우에도 환불되지 않습니다.', contract_type: 'subscription', perspective: 'consumer', knowledge_date: new Date().toISOString().slice(0, 10), scores: { loophole: 0.96, illegal: 0.79 } } },
  { m: 'POST', p: '/v1/summarize', t: '계약 요약 (M4)', d: '요약 + 계약 유형 후보(최대 3).', b: { clauses: [
    { clause_id: 's1', title: '목적', text: '이 약관은 회사가 제공하는 구독형 동영상 서비스의 이용 조건을 정합니다.' },
    { clause_id: 's2', title: '요금', text: '이용요금은 매월 결제일에 등록된 결제수단으로 자동 결제됩니다.' } ] } },
];
let cur = EPS[0];
$('#epList').innerHTML = EPS.map((e, i) => `<button data-i="${i}" aria-pressed="${i === 0}"><span class="m ${e.m === 'POST' ? 'post' : ''}">${e.m}</span><span><code style="border:0;background:none;padding:0">${esc(e.p)}</code><br><span class="small muted">${esc(e.t)}</span></span></button>`).join('');
const realPath = () => (cur.job ? cur.p.replace('{job_id}', encodeURIComponent($('#jobId').value.trim() || '{job_id}')) : cur.p);
function curl() {
  const body = cur.b ? ` \\\n  -H 'content-type: application/json' \\\n  -d '${$('#epBody').value.replace(/'/g, "'\\''").replace(/\n\s*/g, ' ')}'` : '';
  $('#curl').textContent = `curl -s${cur.m === 'POST' ? ' -X POST' : ''} '${CFG.apiBase}${realPath()}' \\\n  -H "Authorization: Bearer $CRD_API_KEY"${body}`;
}
function pick(i) {
  cur = EPS[i];
  document.querySelectorAll('#epList button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === i)));
  $('#epTitle').textContent = `${cur.m} ${cur.p} — ${cur.t}`; $('#epDesc').textContent = cur.d;
  $('#jobIdRow').hidden = !cur.job; $('#bodyRow').hidden = !cur.b;
  if (cur.b) $('#epBody').value = JSON.stringify(cur.b, null, 2);
  $('#epOut').textContent = '—'; $('#sendMeta').textContent = ''; curl();
}
$('#epList').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) pick(Number(b.dataset.i)); });
$('#epBody').addEventListener('input', curl); $('#jobId').addEventListener('input', curl);
$('#btnSend').addEventListener('click', async () => {
  let body;
  if (cur.b) { try { body = JSON.stringify(JSON.parse($('#epBody').value)); } catch { $('#epOut').textContent = 'JSON 형식이 올바르지 않습니다.'; return; } }
  if (cur.job && !$('#jobId').value.trim()) { $('#epOut').textContent = 'job_id 를 넣어 주세요(먼저 POST /v1/jobs 를 보내면 자동으로 채워집니다).'; return; }
  const b = $('#btnSend'); b.disabled = true; $('#epOut').textContent = '보내는 중…';
  const r = await call(cur.m, realPath(), body);
  b.disabled = false;
  $('#sendMeta').innerHTML = `<b class="${r.status >= 500 || !r.status ? 'st5' : r.status >= 400 ? 'st4' : 'st2'}">${r.status || 'ERR'}</b> · ${r.ms ?? '-'}ms${r.reqId ? ` · x-request-id ${esc(r.reqId)}` : ''}`;
  $('#epOut').textContent = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
  if (cur.p === '/v1/jobs' && r.data?.job_id) $('#jobId').value = r.data.job_id;
});
$('#btnClear').addEventListener('click', () => { logEl.innerHTML = '<span class="muted">아직 없습니다.</span>'; });

// ─── 시작 ───
(async () => {
  try { CFG = await (await fetch('/demo-config')).json(); } catch {}
  $('#apiBase').textContent = CFG.apiBase; $('#apiBase2').textContent = CFG.apiBase;
  $('#keyState').innerHTML = CFG.keyConfigured ? '<span class="pill ok">키 설정됨</span>' : '<span class="pill hi">서버에 CRD_API_KEY 없음</span>';
  pick(0);
  // 모델 이름은 개발자 화면에만 — 열 때 1번(GET /v1/models)
  const mv = await call('GET', '/v1/models');
  const list = Array.isArray(mv.data?.models) ? mv.data.models.map((m) => `${m.id ?? ''} ${m.model_version ?? m.version ?? m.name ?? ''}`.trim()) : [];
  $('#modelVersions').textContent = mv.ok ? (list.join(' · ') || mv.data?.model_version || '-') : '확인하지 못했어요';
})();
