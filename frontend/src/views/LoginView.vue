<script setup lang="ts">
// 로그인 · 회원가입(2026-09-30) — 아이디 · 비밀번호만. 간편(소셜) 로그인은 아직 쓰지 않는다.
// 회원가입으로 만든 계정은 사용자 역할이다. 운영자 계정은 관리자가 npm run admin:create-account 로 만든다.
// 이름은 회원가입 때 받아 머리글에 보인다.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const route = useRoute()
const router = useRouter()

type Mode = 'login' | 'signup'
const mode = ref<Mode>(route.query.mode === 'signup' ? 'signup' : 'login')
watch(() => route.query.mode, (m) => (mode.value = m === 'signup' ? 'signup' : 'login'))

const loginId = ref('')
const password = ref('')
const password2 = ref('')
const name = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

const returnTo = computed(() => {
  const r = route.query.returnTo
  const v = Array.isArray(r) ? r[0] : r
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/login') ? v : '/'
})

// 입력 검사(2026-09-30) — 버튼을 비활성으로 막지 않는다(파랗게 보이는데 안 눌리고 이유도 안 보였다).
// 누르거나 칸을 벗어나면 칸마다 무엇이 틀렸는지 보여 주고(aria-invalid · aria-describedby, WCAG 3.3.1), 틀린 첫 칸으로 초점을 옮긴다.
// 규칙은 백엔드 password.service 와 같다(LOGIN_ID_RE · 8~72자 · 영문+숫자 · 이름 1~20자).
const LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{3,31}$/
type Field = 'id' | 'name' | 'pw' | 'pw2'
const touched = ref<Record<Field, boolean>>({ id: false, name: false, pw: false, pw2: false })
const submitted = ref(false)
const serverField = ref<{ field: Field; message: string } | null>(null) // 서버가 알려 준 칸 오류(이미 쓰는 아이디 등)
const INPUT_ID: Record<Field, string> = { id: 'login-id', name: 'signup-name', pw: 'login-password', pw2: 'signup-password2' }

const fieldErrors = computed<Partial<Record<Field, string>>>(() => {
  const e: Partial<Record<Field, string>> = {}
  const id = loginId.value.trim()
  if (mode.value === 'login') {
    if (!id) e.id = '아이디를 넣어 주세요'
    if (!password.value) e.pw = '비밀번호를 넣어 주세요'
  } else {
    if (!id) e.id = '아이디를 정해 주세요'
    else if (!LOGIN_ID_RE.test(id)) e.id = '아이디는 영문 소문자나 숫자로 시작하는 4~32자로 정해 주세요'
    if (!name.value.trim()) e.name = '이름을 적어 주세요'
    if (!password.value) e.pw = '비밀번호를 정해 주세요'
    else if (password.value.length < 8) e.pw = '비밀번호는 8자 이상으로 정해 주세요'
    else if (!/[A-Za-z]/.test(password.value) || !/[0-9]/.test(password.value)) e.pw = '비밀번호에 영문과 숫자를 함께 넣어 주세요'
    if (!password2.value) e.pw2 = '비밀번호를 한 번 더 넣어 주세요'
    else if (password.value !== password2.value) e.pw2 = '위에 넣은 비밀번호와 달라요. 한 번 더 확인해 주세요'
  }
  if (serverField.value && !e[serverField.value.field]) e[serverField.value.field] = serverField.value.message
  return e
})
// 보여 줄 오류(2026-10-01 바꿈)
// · 빈 칸 오류('아이디를 넣어 주세요' 등) — 버튼을 눌렀을 때만 잠깐 깜빡이고(점멸) 몇 초 뒤 스르르 꺼져 원래 칸으로 돌아간다.
//   칸을 벗어났다고(blur) 띄우지 않는다 — 아무것도 적지 않았는데 빨간 줄이 켜져 있었다. 로그인 ↔ 회원가입을 바꾸면 바로 끈다
// · 적었는데 규칙에 안 맞는 오류(아이디 형식 · 비밀번호 길이 · 확인 불일치 · 서버가 알려 준 오류) — 고칠 때까지 그대로 둔다
const VALUE: Record<Field, () => string> = { id: () => loginId.value.trim(), name: () => name.value.trim(), pw: () => password.value, pw2: () => password2.value }
const FLASH_MSG_MS = 2400 // 문구가 꺼지기 시작하는 때(0.5초 동안 옅어짐)
const FLASH_FIELD_MS = 2900 // 칸 테두리 점멸 애니메이션 길이(CSS field-flash 와 같게)
const flashMsg = ref(false)
const flashField = ref(false)
let msgTimer = 0
let fieldTimer = 0
let flashFrame = 0
function stopFlash() {
  cancelAnimationFrame(flashFrame)
  window.clearTimeout(msgTimer)
  window.clearTimeout(fieldTimer)
  flashMsg.value = false
  flashField.value = false
}
function startFlash() {
  stopFlash() // 끈 다음 프레임에 다시 켠다 — 연달아 눌러도 점멸이 처음부터
  flashFrame = requestAnimationFrame(() => {
    flashMsg.value = true
    flashField.value = true
    msgTimer = window.setTimeout(() => (flashMsg.value = false), FLASH_MSG_MS)
    fieldTimer = window.setTimeout(() => (flashField.value = false), FLASH_FIELD_MS)
  })
}
onBeforeUnmount(stopFlash)
const isEmpty = (f: Field) => !VALUE[f]()
function shown(f: Field): string | null {
  const m = fieldErrors.value[f]
  if (!m) return null
  if (serverField.value?.field === f) return m
  if (isEmpty(f)) return flashMsg.value ? m : null
  if (submitted.value || touched.value[f] || (f === 'pw2' && !!password2.value)) return m
  return null
}
const flashing = (f: Field) => flashField.value && isEmpty(f) && !!fieldErrors.value[f]
const describedBy = (f: Field, hint?: string) => [hint, shown(f) ? `${INPUT_ID[f]}-error` : ''].filter(Boolean).join(' ') || undefined
watch([loginId, name, password, password2], () => { if (serverField.value) serverField.value = null })

// 로그인 ↔ 회원가입을 바꿀 때는 남은 문구를 옅어지게 하지 않고 바로 지운다(바뀐 화면에 앞 화면 오류가 0.5초 남아 보였다)
const quiet = ref(false)
function switchMode(m: Mode) {
  quiet.value = true
  requestAnimationFrame(() => requestAnimationFrame(() => (quiet.value = false)))
  stopFlash()
  error.value = null
  submitted.value = false
  serverField.value = null
  touched.value = { id: false, name: false, pw: false, pw2: false }
  void router.replace({ query: { ...route.query, mode: m === 'signup' ? 'signup' : undefined } })
}

// 서버 오류 코드 → 화면 문구(해요체 · 무슨 일 + 할 일). 백엔드 문구(합니다체)는 그대로 두고 여기서 바꾼다
function applyServerError(e: unknown) {
  if (e instanceof ApiError && e.status === 429) return void (error.value = '시도가 너무 많았어요. 잠시 뒤 다시 해 주세요')
  const code = e instanceof ApiError ? e.problem?.code : undefined
  switch (code) {
    case 'login_failed': error.value = '아이디나 비밀번호가 맞지 않아요. 다시 확인해 주세요. 계정이 없다면 회원가입을 해 주세요'; return
    case 'login_id_taken': serverField.value = { field: 'id', message: '이미 쓰고 있는 아이디예요. 다른 아이디를 정해 주세요' }; break
    case 'invalid_login_id': serverField.value = { field: 'id', message: '아이디는 영문 소문자나 숫자로 시작하는 4~32자로 정해 주세요' }; break
    case 'invalid_password': serverField.value = { field: 'pw', message: '비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 정해 주세요' }; break
    case 'invalid_name': serverField.value = { field: 'name', message: '이름을 1~20자로 적어 주세요' }; break
    default: error.value = '지금은 처리할 수 없어요. 잠시 뒤 다시 해 주세요'; return
  }
  focusFirstError()
}
function focusFirstError() {
  const order: Field[] = ['id', 'name', 'pw', 'pw2']
  const f = order.find((k) => fieldErrors.value[k])
  if (f) requestAnimationFrame(() => document.getElementById(INPUT_ID[f])?.focus())
}

async function submit() {
  if (busy.value) return
  submitted.value = true
  error.value = null
  if (Object.keys(fieldErrors.value).length) {
    if ((Object.keys(fieldErrors.value) as Field[]).some(isEmpty)) startFlash()
    return focusFirstError()
  }
  busy.value = true
  try {
    if (mode.value === 'signup') await session.signup(loginId.value.trim(), password.value, name.value.trim(), returnTo.value)
    else await session.login(loginId.value.trim(), password.value, returnTo.value)
    password.value = ''
    password2.value = ''
    await router.replace(returnTo.value === '/' ? session.homePath : returnTo.value)
  } catch (e) {
    applyServerError(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page narrow login-page">
    <div class="page-head">
      <h1 class="t-display-xl">{{ mode === 'signup' ? '회원가입' : '로그인' }}</h1>
      <p class="lede">
        <template v-if="mode === 'signup'">아이디 · 비밀번호 · 이름만 정하면 끝이에요. 가입하면 바로 계약서를 분석할 수 있어요.</template>
        <template v-else>아이디와 비밀번호를 넣어 주세요. 계정이 없다면 회원가입부터 해 주세요.</template>
      </p>
    </div>

    <div v-if="session.loggedIn" class="section tight">
      <div class="card">
        <p class="m-0 mb-md">{{ session.displayName }}({{ session.roleLabel }}) 계정으로 로그인되어 있어요.</p>
        <RouterLink :to="returnTo === '/' ? session.homePath : returnTo" class="btn btn-secondary">돌아가기</RouterLink>
      </div>
    </div>

    <form v-else class="section tight card login-form" data-part="login-form" novalidate @submit.prevent="submit">
      <!-- 로그인 · 회원가입 전환 — 탭 역할(role=tab)은 탭 패널 · 방향키가 없어 맞지 않았다 → 눌림 상태 버튼 두 개(2026-10-01). 모양은 밑줄 탭 그대로 -->
      <div class="tabs underline" role="group" aria-label="로그인 · 회원가입 전환">
        <button type="button" class="tab" :aria-pressed="mode === 'login' ? 'true' : 'false'" data-tab="login" @click="switchMode('login')">로그인</button>
        <button type="button" class="tab" :aria-pressed="mode === 'signup' ? 'true' : 'false'" data-tab="signup" @click="switchMode('signup')">회원가입</button>
      </div>

      <div class="field">
        <label for="login-id" class="t-body-sm-strong">아이디</label>
        <input id="login-id" :class="{ flash: flashing('id') }" v-model="loginId" class="text-input" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="32" required :aria-invalid="shown('id') ? 'true' : undefined" :aria-describedby="describedBy('id', mode === 'signup' ? 'login-id-hint' : undefined)" @blur="touched.id = true" />
        <small v-if="mode === 'signup'" id="login-id-hint" class="t-caption-sm muted">4~32자 · 영문 소문자나 숫자로 시작해요(영문 · 숫자 · . _ - 사용 가능)</small>
        <Transition name="field-msg" :css="!quiet"><small v-if="shown('id')" id="login-id-error" class="field-error" data-part="error-id">{{ shown('id') }}</small></Transition>
      </div>

      <div v-if="mode === 'signup'" class="field">
        <label for="signup-name" class="t-body-sm-strong">이름</label>
        <input id="signup-name" :class="{ flash: flashing('name') }" v-model="name" class="text-input" name="name" autocomplete="name" maxlength="20" required :aria-invalid="shown('name') ? 'true' : undefined" :aria-describedby="describedBy('name', 'signup-name-hint')" @blur="touched.name = true" />
        <small id="signup-name-hint" class="t-caption-sm muted">화면 오른쪽 위에 보이는 이름이에요(20자까지)</small>
        <Transition name="field-msg" :css="!quiet"><small v-if="shown('name')" id="signup-name-error" class="field-error" data-part="error-name">{{ shown('name') }}</small></Transition>
      </div>

      <div class="field">
        <label for="login-password" class="t-body-sm-strong">비밀번호</label>
        <input
          id="login-password"
          v-model="password"
          :class="{ flash: flashing('pw') }"
         
          class="text-input"
          type="password"
          name="password"
          :autocomplete="mode === 'signup' ? 'new-password' : 'current-password'"
          maxlength="72"
          required
          :aria-invalid="shown('pw') ? 'true' : undefined"
          :aria-describedby="describedBy('pw', mode === 'signup' ? 'login-password-hint' : undefined)"
          @blur="touched.pw = true"
        />
        <small v-if="mode === 'signup'" id="login-password-hint" class="t-caption-sm muted">8자 이상 · 영문과 숫자를 섞어 주세요</small>
        <Transition name="field-msg" :css="!quiet"><small v-if="shown('pw')" id="login-password-error" class="field-error" data-part="error-pw">{{ shown('pw') }}</small></Transition>
      </div>

      <div v-if="mode === 'signup'" class="field">
        <label for="signup-password2" class="t-body-sm-strong">비밀번호 확인</label>
        <input id="signup-password2" :class="{ flash: flashing('pw2') }" v-model="password2" class="text-input" type="password" name="password2" autocomplete="new-password" maxlength="72" required :aria-invalid="shown('pw2') ? 'true' : undefined" :aria-describedby="describedBy('pw2')" @blur="touched.pw2 = true" />
        <Transition name="field-msg" :css="!quiet"><small v-if="shown('pw2')" id="signup-password2-error" class="field-error" data-part="error-pw2">{{ shown('pw2') }}</small></Transition>
      </div>

      <p v-if="error" role="alert" class="t-body-sm m-0" data-part="login-error">{{ error }}</p>

      <div class="row">
        <button type="submit" class="btn btn-primary" :disabled="busy" :aria-busy="busy ? 'true' : undefined" data-action="submit">
          {{ busy ? '확인 중…' : mode === 'signup' ? '가입하고 시작하기' : '로그인' }}
        </button>
        <button v-if="mode === 'login'" type="button" class="btn btn-text" @click="switchMode('signup')">처음이신가요? 회원가입</button>
        <button v-else type="button" class="btn btn-text" @click="switchMode('login')">이미 계정이 있어요</button>
      </div>
      <p v-if="session.failed" class="muted m-0">로그인 정보를 불러오지 못했어요. 잠시 뒤 새로 고침해 주세요.</p>
    </form>
  </div>
</template>

<style scoped>
/* 가로 가운데 · 세로는 위쪽 고정(2026-10-01) — 세로 정중앙이면 로그인 ↔ 회원가입을 바꿀 때 칸 수 차이로 제목이 약 95px 위아래로 튀었다.
   위 여백은 화면 높이의 9%(24~96px)라 로그인은 여전히 화면 가운데쯤에 온다 */
.login-page { min-height: calc(100dvh - var(--header-height, 72px) - 120px); display: flex; flex-direction: column; justify-content: flex-start; align-items: center; padding-top: clamp(24px, 9vh, 96px); padding-bottom: var(--spacing-xl); }
.login-page .page-head { padding-top: 0; align-items: center; text-align: center; }
.login-page > * { width: 100%; max-width: 440px; }
.login-page > .page-head { max-width: 560px; }
.login-form { display: flex; flex-direction: column; gap: var(--spacing-lg); max-width: 440px; margin-left: auto; margin-right: auto; }
/* 로그인 · 회원가입 탭 — 테마의 .tabs.underline(overflow-x:auto)이 -1px 밑줄 때문에 스크롤 막대를 만든다 → 이 화면에서는 넘침 없음 */
.login-form .tabs.underline { overflow: visible; }
.login-form .tabs.underline .tab { flex: 1; justify-content: center; }
/* 눌린 쪽 = 테마의 선택된 밑줄 탭과 같은 모양(aria-selected 는 버튼에 쓸 수 없는 속성이라 aria-pressed 로 잡는다) */
.login-form .tabs.underline .tab[aria-pressed="true"] { color: var(--color-ink); font-weight: 600; border-bottom-color: var(--color-primary); }
.field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
/* 칸 오류(2026-10-01) — 느낌표 없이 글자 + 칸 테두리. 빈 칸 오류는 잠깐 깜빡인 뒤 스르르 꺼진다(아래 field-flash) */
.field-error { font: 500 13px/1.45 var(--font-sans); color: var(--color-danger); }
.field .text-input[aria-invalid="true"] { border-color: var(--color-danger); box-shadow: 0 0 0 1px var(--color-danger); }
/* 입력칸 — 마우스를 올리면 선이 부드럽게 짙어지고 옅은 테두리 빛이 번진다, 누르면(초점) 파란 선. 바뀜은 0.3초 감속 곡선 */
.login-form .text-input { transition: border-color .3s cubic-bezier(.22, 1, .36, 1), box-shadow .3s cubic-bezier(.22, 1, .36, 1), background-color .3s ease-out; }
.login-form .text-input:hover:not(:focus) { border-color: color-mix(in srgb, var(--color-ink) 55%, var(--color-hairline-strong)); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-ink) 5%, transparent); }
.login-form .text-input:focus { border-color: var(--color-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary) 14%, transparent); }
/* 점멸 — 빨간 테두리 빛이 두 번 깜빡이고 잠시 머문 뒤 원래 칸으로 옅어진다(2.9초, 스크립트 FLASH_FIELD_MS 와 같게) */
.login-form .text-input.flash { animation: field-flash 2.9s cubic-bezier(.4, 0, .2, 1) both; }
@keyframes field-flash {
  0% { border-color: var(--color-hairline-strong); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 0%, transparent); }
  10% { border-color: var(--color-danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-danger) 26%, transparent); }
  22% { border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-hairline-strong)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-danger) 6%, transparent); }
  34% { border-color: var(--color-danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-danger) 22%, transparent); }
  48%, 72% { border-color: var(--color-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 12%, transparent); }
  100% { border-color: var(--color-hairline-strong); box-shadow: 0 0 0 0 color-mix(in srgb, var(--color-danger) 0%, transparent); }
}
/* 초점이 간 칸(첫 빈 칸)은 꺼진 뒤 파란 초점 선으로 이어진다 */
.login-form .text-input.flash:focus { animation-name: field-flash-focus; }
@keyframes field-flash-focus {
  0% { border-color: var(--color-primary); }
  10% { border-color: var(--color-danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-danger) 26%, transparent); }
  22% { border-color: color-mix(in srgb, var(--color-danger) 45%, var(--color-hairline-strong)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-danger) 6%, transparent); }
  34% { border-color: var(--color-danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-danger) 22%, transparent); }
  48%, 72% { border-color: var(--color-danger); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-danger) 12%, transparent); }
  100% { border-color: var(--color-primary); box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-primary) 14%, transparent); }
}
.field-msg-enter-active { transition: opacity .22s ease-out, transform .22s cubic-bezier(.22, 1, .36, 1); }
.field-msg-leave-active { transition: opacity .5s ease-in, transform .5s ease-in; }
.field-msg-enter-from { opacity: 0; transform: translateY(-3px); }
.field-msg-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .login-form .text-input { transition: none; }
  .login-form .text-input.flash, .login-form .text-input.flash:focus { animation: none; border-color: var(--color-danger); }
  .field-msg-enter-active, .field-msg-leave-active { transition: none; }
}
/* 설명 줄 — 한국어는 글자 단위로 끊겨 "요."만 떨어졌다 → 띄어쓰기 단위로 끊고(keep-all) 두 줄 길이를 맞춘다 */
.login-page .lede { word-break: keep-all; text-wrap: balance; }
</style>
