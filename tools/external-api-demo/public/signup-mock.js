// [시연용 UI] 회원가입 2단계(약관 동의 → 정보 입력) 흉내 — 서버를 부르지 않고 아무것도 저장하지 않는다.
// 실제 기능(약관 AI 분석)은 terms-analysis.js 에 있다. 이 파일은 그것과 독립적으로 동작한다.
const $ = (s) => document.querySelector(s);

export function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// 버튼 안내 — 시연용(실제 발송·조회 없음)
$('#btnOtp').addEventListener('click', () => toast('인증번호를 보냈어요 (시연용 — 실제 발송 없음)'));
$('#btnIdCheck').addEventListener('click', () => {
  const v = $('#f-id').value.trim();
  toast(/^[a-z0-9]{4,20}$/.test(v) ? '사용할 수 있는 아이디예요 (시연용)' : '아이디는 영문 소문자·숫자 4~20자로 정해 주세요');
});

// 가입 단계 — ① 약관 동의 → ② 정보 입력 → ③ 가입 완료. 같은 화면 안에서 바꾸므로 약관 분석 결과는 그대로 남는다
const stepper = $('#stepper');
function goStep(n) {
  $('#step1').hidden = n !== 1;
  $('#step2').hidden = n !== 2;
  stepper.querySelectorAll('li').forEach((li) => {
    const k = Number(li.dataset.step);
    if (k === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    li.classList.toggle('done', k < n);
  });
  if (n < 3) {
    stepper.scrollIntoView({ block: 'start' });
    (n === 1 ? $('#btnNext') : $('#f-id')).focus({ preventScroll: true });
  }
}

// 1단계 · 약관 동의 — 전체 동의 ↔ 개별, 마케팅 ↔ 문자·이메일
const all = $('#a-all'), mkt = $('#a-mkt');
const boxes = [...document.querySelectorAll('#agree input[type=checkbox]:not(#a-all)')];
const required = boxes.filter((b) => b.hasAttribute('data-req'));
const mktSubs = boxes.filter((b) => b.hasAttribute('data-mkt'));
function refreshAgree() {
  mkt.checked = mktSubs.every((b) => b.checked);
  all.checked = boxes.every((b) => b.checked);
  $('#btnNext').disabled = !required.every((b) => b.checked);
}
all.addEventListener('change', () => { boxes.forEach((b) => { b.checked = all.checked; }); refreshAgree(); });
mkt.addEventListener('change', () => { mktSubs.forEach((b) => { b.checked = mkt.checked; }); refreshAgree(); });
boxes.filter((b) => b !== mkt).forEach((b) => b.addEventListener('change', refreshAgree));
$('#btnNext').addEventListener('click', () => { if (!$('#btnNext').disabled) goStep(2); });
$('#btnPrev').addEventListener('click', () => goStep(1));

// 2단계 · 정보 입력 — 다 채우면 「가입하기」가 눌린다
const id = $('#f-id'), email = $('#f-email'), pw = $('#f-pw'), pw2 = $('#f-pw2'), name = $('#f-name'), phone = $('#f-phone');
const pwOk = () => pw.value.length >= 8 && /[A-Za-z]/.test(pw.value) && /\d/.test(pw.value);
function checkFields() {
  $('#h-pw').className = 'hint' + (pw.value && !pwOk() ? ' bad' : '');
  $('#h-pw2').textContent = pw2.value && pw2.value !== pw.value ? '비밀번호가 일치하지 않아요' : '';
  $('#h-pw2').className = 'hint bad';
  return /^[a-z0-9]{4,20}$/.test(id.value.trim()) && /.+@.+\..+/.test(email.value) && pwOk() && pw.value === pw2.value && name.value.trim() && phone.value.replace(/\D/g, '').length >= 10;
}
function refreshFields() { $('#btnSubmit').disabled = !checkFields(); }
[id, email, pw, pw2, name, phone].forEach((i) => i.addEventListener('input', refreshFields));

// 가입하기 — ③ 가입 완료(완료 창만 보여 준다)
$('#signupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('#step2').hidden || $('#btnSubmit').disabled) return;
  goStep(3);
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-t">
    <div class="ok">✓</div><h3 id="m-t"></h3>
    <p>첫 구매 3,000원 쿠폰이 발급됐어요.<br><span style="font-size:12px">시연용 화면이라 실제로 가입되지는 않아요.</span></p>
    <button type="button" class="submit" style="margin:0">쇼핑 시작하기</button></div>`;
  bg.querySelector('#m-t').textContent = `${name.value.trim()}님, 환영해요!`;
  bg.querySelector('button').addEventListener('click', () => bg.remove());
  document.body.append(bg);
  bg.querySelector('button').focus();
});

// 모바일 미리보기(시연용) — 같은 주소를 휴대폰 크기(390×844) 틀에 띄운다. 틀 안에서는 시연 표시를 숨긴다
if (window.top !== window.self) document.documentElement.classList.add('embedded');
const phoneBg = $('#phoneBg');
let phoneOpener = null;
function fitPhone() {
  const wrap = phoneBg.querySelector('.phone-wrap');
  const need = 868 + 40;   // 화면 844 + 테두리 24 + 위 막대
  wrap.style.transform = innerHeight < need + 24 ? `scale(${((innerHeight - 24) / need).toFixed(3)})` : '';
}
$('#btnMobile')?.addEventListener('click', (e) => {
  phoneOpener = e.currentTarget;
  $('#phoneFrame').src = '/';
  phoneBg.hidden = false;
  fitPhone();
  $('#phoneClose').focus();
});
function closePhone() {
  if (phoneBg.hidden) return;
  phoneBg.hidden = true;
  $('#phoneFrame').src = 'about:blank';
  phoneOpener?.focus();
}
$('#phoneClose')?.addEventListener('click', closePhone);
phoneBg?.addEventListener('click', (e) => { if (e.target === phoneBg) closePhone(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePhone(); });
addEventListener('resize', () => { if (!phoneBg.hidden) fitPhone(); });
