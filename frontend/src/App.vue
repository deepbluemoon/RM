<script setup lang="ts">
// T038 앱 셸 — 머리글(로고 · 가운데 메뉴 · 오른쪽 이름·로그아웃) + 두 줄 햄버거 → 오른쪽에서 밀려 나오는 메뉴 창(2026-09-30).
// 메뉴 창 안에서 바로 다른 화면으로 옮겨 간다: 분석하기 · 운영 · API 활용 · 계정. 사용자 메뉴와 운영 메뉴는 분리(SD_02 §2-2).
// 역할은 운영자 · 사용자 두 부류 — 운영자는 운영 메뉴가 먼저 보이는 운영자 화면이다.
// RBAC: 로그인한 역할의 권한이 있는 메뉴만 보인다(G14 — 권한 없으면 메뉴 자체가 없다). 판정 원천은 서버 GET /api/session
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { AUTH_REQUIRED_EVENT } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const route = useRoute()
const router = useRouter()
const menuOpen = ref(false)
const scrolled = ref(false)
const burgerEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)

watch(() => route.fullPath, () => (menuOpen.value = false))
// 운영자(운영 권한 역할)로 로그인하면 사이트 전체 글자를 한 단계 굵게 — html.role-operator(아래 <style>)
watch(() => session.isOperator, (op) => document.documentElement.classList.toggle('role-operator', op), { immediate: true })
// 닫을 때는 창이 다 빠져나간 뒤(transitionend)에 스크롤 잠금을 푼다 — 먼저 풀면 Windows 스크롤바(17px)가 돌아오며 미끄러지는 창이 옆으로 튄다.
// 전환이 안 끝나는 경우(모션 줄이기 · 탭 숨김)를 위해 예비 시간 CLOSE_MS + 150ms
const CLOSE_MS = 300
let unlockTimer: ReturnType<typeof setTimeout> | null = null
watch(menuOpen, async (open) => {
  // 잠그기 직전 스크롤바 폭(Windows 고전 스크롤바 ≈17px, 겹침 스크롤바 = 0)을 재서 그만큼 오른쪽을 채운다 — 잠글 때 화면이 옆으로 튀지 않게
  if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null }
  if (open) {
    if (!document.body.classList.contains('menu-locked')) document.documentElement.style.setProperty('--scroll-gap', `${window.innerWidth - document.documentElement.clientWidth}px`)
    document.body.classList.add('menu-locked')
  } else {
    const panel = panelEl.value
    const unlock = () => {
      panel?.removeEventListener('transitionend', onEnd)
      if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = null }
      if (!menuOpen.value) document.body.classList.remove('menu-locked')
    }
    const onEnd = (e: TransitionEvent) => { if (e.target === panel && e.propertyName === 'transform') unlock() }
    panel?.addEventListener('transitionend', onEnd)
    unlockTimer = setTimeout(unlock, CLOSE_MS + 150)
  }
  if (open) {
    await nextTick()
    // preventScroll — 화면 밖에서 미끄러져 들어오는 중인 창 안 요소에 초점을 줄 때 브라우저가 스크롤을 움직여 튀지 않게
    panelEl.value?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true })
  }
})
async function closeMenu() {
  menuOpen.value = false
  // 머리글의 inert 가 풀린 다음(다음 그리기)에 초점을 준다 — inert 인 동안엔 초점이 가지 않는다
  await nextTick()
  // preventScroll — html 의 scroll-padding-top(120px) 때문에 머리글 속 버튼에 초점을 주면 페이지가 맨 위로 끌려 올라간다(측정: 150→0)
  burgerEl.value?.focus({ preventScroll: true })
}

const apiLink = (tab: string) => ({ path: '/api-guide', query: { tab } })
// API 메뉴는 모두 같은 주소(/api-guide)라 라우터의 '현재 페이지' 판정이 ?tab= 을 무시하고 네 개를 다 현재로 잡았다(2026-09-30).
// → 지금 화면의 tab(없거나 모르는 값이면 첫 탭 endpoints — S9 와 같은 규칙)과 같은 항목 하나만 현재로 표시한다
const apiTabNow = computed(() => {
  if (route.name !== 'model-api') return null
  const q = route.query.tab
  return typeof q === 'string' && session.apiMenu.some((a) => a.tab === q) ? q : 'endpoints'
})
// 로그인 · 회원가입도 같은 주소(/login)라 둘 다 현재로 잡혔다(2026-10-01) → ?mode= 로 하나만(LoginView 와 같은 규칙: signup 아니면 login)
const loginModeNow = computed(() => (route.name === 'login' ? (route.query.mode === 'signup' ? 'signup' : 'login') : null))
const homeLink = computed(() => (session.loggedIn ? session.homePath : '/login'))

async function logout() {
  menuOpen.value = false
  await session.logout()
  await router.replace({ name: 'login' })
}
// API 가 401(G8 로그인 필요)을 돌려주면 — 세션 만료·다른 탭에서 로그아웃 — 로그인 화면으로
async function onAuthRequired() {
  await session.load(true)
  if (!session.loggedIn && route.name !== 'login') await router.replace({ name: 'login', query: { returnTo: route.fullPath } })
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && menuOpen.value) closeMenu()
  if (e.key === 'Tab' && menuOpen.value) trapTab(e)
}
// 메뉴 창은 aria-modal — 열려 있는 동안 Tab · Shift+Tab 이 창 안에서만 돈다(2026-09-30: Tab 7번이면 가려진 본문으로 빠져나갔다)
function trapTab(e: KeyboardEvent) {
  const panel = panelEl.value
  if (!panel) return
  const items = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!panel.contains(active)) { e.preventDefault(); first.focus(); return }
  if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
  else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
}
function onScroll() {
  scrolled.value = window.scrollY > 4
}
onMounted(() => {
  void session.load()
  window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  window.addEventListener('keydown', onKey)
  window.addEventListener('scroll', onScroll, { passive: true })
  prefetchScreens()
})
// 화면 코드 미리 받기(2026-10-01) — 화면마다 코드를 처음 누를 때 받느라 누른 뒤 ~130ms 동안 아무것도 안 바뀌다 툭 바뀌었다(측정).
// 브라우저가 한가할 때 내 역할로 갈 수 있는 화면 코드를 미리 받아 두면 누르는 즉시 새 화면이 떠오른다. 실패해도 그냥 둔다(누를 때 다시 받음)
function prefetchScreens() {
  const idle = (f: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 1500))
  idle(() => {
    for (const r of router.getRoutes()) {
      if (r.meta.ops && !session.isOperator) continue
      const c = r.components?.default
      if (typeof c === 'function' && !('render' in c) && !('setup' in c)) (c as () => Promise<unknown>)().catch(() => {})
    }
  })
}
onBeforeUnmount(() => {
  window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', onScroll)
  if (unlockTimer) clearTimeout(unlockTimer)
  document.body.classList.remove('menu-locked')
  document.documentElement.classList.remove('role-operator')
})
</script>

<template>
  <a class="visually-hidden" href="#main">본문으로 건너뛰기</a>
  <!-- 메뉴 창이 열려 있는 동안 뒤쪽은 inert — 스크린 리더 가상 커서도 창 밖으로 빠지지 않게(2026-10-01) -->
  <header :class="['app-nav', { scrolled, 'menu-open': menuOpen }]" :inert="menuOpen || undefined">
    <nav class="primary-nav" aria-label="주 메뉴">
      <RouterLink :to="homeLink" class="brand" aria-label="ReadMe — 처음으로">
        <span class="brand-mark" aria-hidden="true" data-part="brand-mark"></span>
        <span>ReadMe</span>
      </RouterLink>
      <div v-if="session.userMenu.length" class="links" role="group" aria-label="사용자 메뉴">
        <RouterLink v-for="m in session.userMenu" :key="m.to" :to="m.to" :exact-active-class="m.to === '/' ? 'router-link-active' : undefined">{{ m.label }}</RouterLink>
      </div>
      <div v-if="session.opsMenu.length" class="links" role="group" aria-label="운영 메뉴">
        <RouterLink v-for="m in session.opsMenu" :key="m.to" :to="m.to">{{ m.label }}</RouterLink>
      </div>
      <span class="spacer" />
      <div class="right">
        <template v-if="session.loggedIn">
          <span class="who" data-testid="who">{{ session.displayName }}<span v-if="session.isOperator" class="role-tag">{{ session.roleLabel }}</span></span>
          <button type="button" class="btn btn-secondary" @click="logout">로그아웃</button>
        </template>
        <RouterLink v-else-if="route.name !== 'login'" to="/login" class="btn btn-secondary">로그인</RouterLink>
        <button
          ref="burgerEl"
          type="button"
          class="burger"
          :aria-expanded="menuOpen ? 'true' : 'false'"
          aria-controls="menu-panel"
          :aria-label="menuOpen ? '메뉴 닫기' : '메뉴 열기'"
          data-part="burger"
          @click="menuOpen = !menuOpen"
        >
          <svg width="24" height="25" viewBox="0 0 24 25" fill="none" aria-hidden="true"><path d="M3 9.5L21 9.5" stroke="currentColor" stroke-width="1.5" /><path d="M3 15.5L21 15.5" stroke="currentColor" stroke-width="1.5" /></svg>
        </button>
      </div>
    </nav>
  </header>

  <!-- 햄버거 메뉴 창 — 오른쪽에서 일부만 밀려 나온다. 바깥(어두운 막)을 누르거나 Esc 로 닫는다 -->
  <div :class="['menu-scrim', { open: menuOpen }]" aria-hidden="true" data-part="menu-scrim" @click="closeMenu" />
  <aside
    id="menu-panel"
    ref="panelEl"
    :class="['menu-panel', { open: menuOpen }]"
    role="dialog"
    aria-modal="true"
    aria-label="전체 메뉴"
    :aria-hidden="menuOpen ? undefined : 'true'"
    :inert="!menuOpen || undefined"
    data-part="menu-panel"
  >
    <div class="menu-head">
      <div v-if="session.loggedIn" class="menu-account" data-part="menu-account">
        <strong>{{ session.displayName }}</strong>
        <small>{{ session.roleLabel }} 계정</small>
      </div>
      <strong v-else>메뉴</strong>
      <button type="button" class="menu-close" aria-label="메뉴 닫기" @click="closeMenu">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
    </div>

    <nav class="menu-body" aria-label="전체 메뉴 목록">
      <section v-if="session.opsMenu.length" class="menu-group" data-group="ops">
        <h2>운영</h2>
        <ul>
          <li v-for="m in session.opsMenu" :key="m.to"><RouterLink :to="m.to">{{ m.label }}<small>{{ m.sub }}</small></RouterLink></li>
        </ul>
      </section>

      <section v-if="session.userMenu.length" class="menu-group" data-group="analyze">
        <h2>분석</h2>
        <ul>
          <li v-for="m in session.userMenu" :key="m.to"><RouterLink :to="m.to">{{ m.label }}<small>{{ m.sub }}</small></RouterLink></li>
        </ul>
      </section>

      <section v-if="session.apiMenu.length" class="menu-group" data-group="api">
        <h2>API 활용</h2>
        <ul>
          <li v-for="a in session.apiMenu" :key="a.tab">
            <RouterLink v-slot="{ href, navigate }" :to="apiLink(a.tab)" custom>
              <a :href="href" :class="{ 'router-link-exact-active': apiTabNow === a.tab }" :aria-current="apiTabNow === a.tab ? 'page' : undefined" :data-api-tab="a.tab" @click="navigate">{{ a.label }}<small>{{ a.sub }}</small></a>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="menu-group" data-group="account">
        <h2>계정</h2>
        <ul>
          <li v-if="session.loggedIn"><button type="button" data-action="logout" @click="logout">로그아웃<small>이 브라우저에서 로그아웃해요</small></button></li>
          <template v-else>
            <li v-for="l in [{ mode: 'login', to: '/login', label: '로그인', sub: '아이디와 비밀번호로 들어가요' }, { mode: 'signup', to: { path: '/login', query: { mode: 'signup' } }, label: '회원가입', sub: '1분이면 새 계정을 만들 수 있어요' }]" :key="l.mode">
              <RouterLink v-slot="{ href, navigate }" :to="l.to" custom>
                <a :href="href" :class="{ 'router-link-exact-active': loginModeNow === l.mode }" :aria-current="loginModeNow === l.mode ? 'page' : undefined" :data-login-mode="l.mode" @click="navigate">{{ l.label }}<small>{{ l.sub }}</small></a>
              </RouterLink>
            </li>
          </template>
        </ul>
      </section>
    </nav>

    <p class="menu-foot">분석 결과는 법률 자문이 아니에요. 위험할 수 있는 조항을 알려 드리는 안내예요. · Esc 로 닫기</p>
  </aside>

  <main id="main" :inert="menuOpen || undefined">
    <!-- 화면 바뀜(2026-10-01) — 새 화면만 0.24초 감속 곡선으로 살짝 떠오르며 나타난다. 옛 화면은 바로 뺀다(먼저 사라지게 하면 맨 위로 튄 뒤 사라지고 기다림이 생겼다).
         같은 화면 안 탭(?tab=)은 주소 경로가 같아 다시 움직이지 않는다 -->
    <RouterView v-slot="{ Component, route: r }">
      <Transition name="page">
        <component :is="Component" :key="r.path" />
      </Transition>
    </RouterView>
  </main>

  <footer class="footer-section" :inert="menuOpen || undefined">
    <span v-if="session.isOperator">운영자 화면이에요. 이용자에게 보이는 결과는 법률 자문이 아니라, 위험할 수 있는 조항을 알려 드리는 안내예요.</span>
    <span v-else>분석 결과는 법률 자문이 아니에요. 위험할 수 있는 조항을 알려 드리는 안내예요.</span>
    <nav v-if="session.userMenu.length || session.opsMenu.length" aria-label="바닥글">
      <RouterLink v-for="m in [...session.opsMenu, ...session.userMenu]" :key="m.to" :to="m.to">{{ m.label }}</RouterLink>
    </nav>
  </footer>
</template>

<style>
/* 메뉴 창 모션 · 현재 메뉴 표시(2026-09-30) — 테마 CSS(components.css) 교체와 무관하게 남도록 여기 둔다. #menu-panel 로 테마 규칙보다 우선.
   열기 = 감속 곡선 0.46초로 미끄러져 들어온다. 닫기 = 0.24초로 빠르게. 모션 줄이기면 옅어지기만
   끊김 방지(측정 근거): ① 스크롤 잠금(body overflow:hidden)이 Windows 고전 스크롤바(17px)를 없애 화면 폭이 17px 늘고 내용·햄버거가 튐 → 없어진 폭만큼 오른쪽 채우기(scrollbar-gutter 는 겹침 스크롤바 환경에서 검증 불가라 안 씀)
   ② 그림자(box-shadow) 전환이 매 프레임 다시 그리기(0.8초에 Paint 32회) → 그림자는 고정, 움직임은 transform·opacity 만 ③ 창을 미리 별도 레이어로(will-change)
   ④ 그룹 차례 등장(stagger)은 뺐다 — 여는 0.8초 동안 다시 그리기 29회 중 23회가 여기서 나옴(측정), 빼면 6회 ⑤ 초점 이동은 preventScroll(닫을 때 페이지가 맨 위로 끌려 올라가던 것) */
html:has(body.menu-locked){overflow:hidden;padding-right:var(--scroll-gap,0px)} /* 잠금 = 스크롤 주인(html) + 없어진 스크롤바 폭만큼 채우기 */
/* 닫기 = 0.3초 표준 곡선(가속 후 감속) — 가속만 하는 곡선은 끝에서 최고 속도로 뚝 끊겨 보였다. 잠금 해제(CLOSE_MS)와 길이를 맞춘다 */
#menu-panel{will-change:transform;box-shadow:-24px 0 48px rgba(15,14,13,.14);transition:transform .3s cubic-bezier(.4,0,.2,1),visibility 0s linear .3s}
#menu-panel.open{transition:transform .46s cubic-bezier(.22,1,.36,1)}
.menu-scrim{transition:opacity .3s cubic-bezier(.4,0,.2,1),visibility 0s linear .3s}
.menu-scrim.open{transition:opacity .36s cubic-bezier(.22,1,.36,1)}

/* 운영자 굵게(2026-09-30) — 글꼴 굵기가 font 단축 속성에 박혀 있어 굵기 값을 올릴 수 없으므로, 모든 글자에 같은 두께 외곽선을 더해 위계는 유지한 채 한 단계 굵게 */
html.role-operator body{-webkit-text-stroke:.3px currentColor}
html.role-operator :is(input,textarea,select){-webkit-text-stroke:.3px currentColor}
@media (prefers-reduced-motion:reduce){
  #menu-panel,#menu-panel.open{transform:none;opacity:0;transition:opacity .15s linear,visibility 0s linear .15s}
  #menu-panel.open{opacity:1;transition:opacity .15s linear}
}

/* 화면 바뀜 — opacity · transform 만(합성 단계), 옛 화면은 바로 감춘다. 모션 줄이기면 없음 */
.page-enter-active{transition:opacity .24s cubic-bezier(.22,1,.36,1),transform .24s cubic-bezier(.22,1,.36,1)}
.page-enter-from{opacity:0;transform:translateY(8px)}
.page-leave-active{display:none}
/* 화면 바뀜 흔들림(2026-10-01, 측정) — ① 짧은 화면(분석 기록 800px)↔긴 화면(새 분석 1095px)을 오가면 Windows 스크롤바(17px)가 생겼다 없어지며 화면 전체가 옆으로 튐
   → 스크롤바 자리를 늘 둔다(메뉴 잠금은 overflow:hidden + --scroll-gap 그대로 맞물림) ② 새 화면이 아직 짧을 때(불러오는 중) 바닥글이 1006→380 으로 화면 가운데까지 올라왔다 내려감
   → 본문 최소 높이 = 화면 높이 − 머리글(65) − 위 여백(32) */
html{overflow-y:scroll}
html #main{min-height:calc(100svh - 97px)}
/* 끝까지 당겼을 때 흔들림(2026-10-01) — 트랙패드로 끝을 넘겨 당기면 페이지가 고무줄처럼 튕기는데(rubber-band), 그동안 고정된 배경 구름(body::before)과
   반투명 머리글(backdrop-filter)이 본문과 따로 움직여 떨려 보였고, 튕겨 드러난 빈 곳은 구름 없는 맨바탕이었다
   → 마우스 · 트랙패드 환경은 끝에서 튕기지 않고 그대로 멈춘다(관성 스크롤의 감속은 그대로라 부드럽게 선다).
   손가락(휴대폰)은 당겨서 새로 고침을 살려 두고, 드러나는 바탕만 본문과 같은 색으로 맞춘다 */
html{background:var(--color-canvas)}
@media (hover:hover) and (pointer:fine){html{overscroll-behavior-y:none}}

/* 다른 열고 닫는 판(2026-10-01) — 툭 나타나던 것을 열기 = 감속 곡선, 닫기 = 짧게. transform · opacity 만. 모션 줄이기면 없음
   · 오른쪽 서랍(출처 D1 · 의견 S5): 미끄러져 들어오고 나감(.drawer.open 이 처음부터 붙어 있어 기존 transition 이 돌지 않았다) */
html .drawer-slide-enter-active{transition:transform .36s cubic-bezier(.22,1,.36,1)}
html .drawer-slide-leave-active{transition:transform .24s cubic-bezier(.4,0,.2,1)}
html .drawer.drawer-slide-enter-from,html .drawer.drawer-slide-leave-to{transform:translateX(100%)}
html .scrim-fade-enter-active{transition:opacity .3s cubic-bezier(.22,1,.36,1)}
html .scrim-fade-leave-active{transition:opacity .24s cubic-bezier(.4,0,.2,1)}
html .scrim.scrim-fade-enter-from,html .scrim.scrim-fade-leave-to{opacity:0}
/* · 확인 창(삭제 · 취소 등): 바탕은 옅어지고 창은 살짝 커지며 떠오름 */
html .dialog-pop-enter-active,html .dialog-pop-enter-active .dialog{transition:opacity .24s cubic-bezier(.22,1,.36,1),transform .24s cubic-bezier(.22,1,.36,1)}
html .dialog-pop-leave-active,html .dialog-pop-leave-active .dialog{transition:opacity .16s ease-in,transform .16s ease-in}
html .dialog-pop-enter-from,html .dialog-pop-leave-to{opacity:0}
html .dialog-pop-enter-from .dialog,html .dialog-pop-leave-to .dialog{transform:translateY(8px) scale(.97)}
/* · 작은 메뉴(결과 관리): 버튼 쪽(오른쪽 위)에서 펼쳐짐 */
html .pop-enter-active{transition:opacity .18s ease-out,transform .18s cubic-bezier(.22,1,.36,1)}
html .pop-leave-active{transition:opacity .12s ease-in,transform .12s ease-in}
html .pop-enter-from,html .pop-leave-to{opacity:0;transform:translateY(-4px) scale(.97)}
html .menu-pop{transform-origin:top right}
@media (prefers-reduced-motion:reduce){
  html :is(.drawer-slide-enter-active,.drawer-slide-leave-active,.scrim-fade-enter-active,.scrim-fade-leave-active,.dialog-pop-enter-active,.dialog-pop-leave-active,.pop-enter-active,.pop-leave-active),
  html :is(.dialog-pop-enter-active,.dialog-pop-leave-active) .dialog{transition:none}
}
@media (prefers-reduced-motion:reduce){.page-enter-active{transition:none}.page-enter-from{opacity:1;transform:none}}

/* 현재 메뉴 — 밑줄 대신: 나머지는 한 단계 옅게, 현재 항목은 진한 글자 + 옅은 바탕 + 왼쪽 파란 막대(aria-current="page" 는 RouterLink 가 붙인다) */
#menu-panel .menu-group a,#menu-panel .menu-group button{position:relative;color:var(--color-charcoal);font-weight:500;border-radius:var(--rounded-md);margin:1px calc(-1 * var(--spacing-md));padding:10px var(--spacing-md);width:calc(100% + 2 * var(--spacing-md));transition:background-color .15s ease-out,color .15s ease-out}
#menu-panel .menu-group a small,#menu-panel .menu-group button small{color:var(--color-body)}
#menu-panel .menu-group a:hover,#menu-panel .menu-group button:hover{color:var(--color-ink);background:var(--color-surface-soft)}
#menu-panel .menu-group a.router-link-exact-active{color:var(--color-ink);font-weight:700;text-decoration:none;background:var(--color-accent-faint)}
#menu-panel .menu-group a.router-link-exact-active small{color:var(--color-charcoal)}
#menu-panel .menu-group a.router-link-exact-active::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:2px;background:var(--color-primary)}
#menu-panel .menu-group a:focus-visible,#menu-panel .menu-group button:focus-visible{outline:2px solid var(--color-primary);outline-offset:-2px}

/* 검토 수정(2026-09-30) — 테마 CSS 교체와 무관하게 남도록 여기 둔다. 테마 CSS 가 이 블록보다 늦게 실리므로 html 을 앞에 붙여 이긴다 */
/* ① .page-head{flex-direction:column} 이 .row 를 덮어써 items-end 가 '오른쪽 정렬'이 됐다(결과 화면 제목이 오른쪽 끝, 왼쪽 절반 빈칸) → 가로 배치로 */
.page-head.row{flex-direction:row}
/* ⑨ 비활성 버튼 — 옅은 바탕에 옅은 글자(2.47:1)라 주 버튼 자리가 안 보였다 → 진한 글자 + 테두리(비활성은 파란 채움이 없는 것으로 구분)
   2026-10-01: 실선 테두리면 눌리는 보조 버튼(흰 바탕 · 같은 실선)과 바탕 차이 1.07:1뿐이라 구분이 안 됐다 → 비활성은 점선 테두리 · 옅은 바탕 */
html .btn-disabled,html .btn[aria-disabled="true"],html .btn[aria-disabled="true"]:hover{background:var(--color-surface-soft);color:var(--color-charcoal);border:1.5px dashed var(--color-hairline-strong);cursor:not-allowed}
/* 키보드 초점 — 테마의 반투명 링(rgba .55)은 흰 바탕 1.87:1 · 어두운 머리 띠 2.38:1 로 WCAG 1.4.11(3:1) 미달이었다(2026-10-01 측정)
   → 불투명 2px 테두리: 파랑 #0061fe 는 흰 바탕 5.1:1, 어두운 띠 안에서는 밝은 글자색(14.7:1). 링을 따로 둔 곳(#menu-panel 링크 · 게이트 제목)은 그쪽 규칙이 더 구체적이라 그대로 */
html :focus-visible{outline:2px solid var(--color-primary);outline-offset:2px;box-shadow:none}
html .hero :focus-visible{outline-color:var(--color-on-dark)}
html .text-input:focus-visible,html textarea.text-area:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px;box-shadow:none} /* 입력칸 — 테마의 .text-input:focus{outline:none} 가 더 구체적이라 다시 걸고, 반투명 링은 뺀다(두 겹 방지) */
/* ⑫ 권한 없음(차단형 full) — 제목 줄만 왼쪽에 붙어 본문과 어긋났다 → 가운데 */
html .gate.full .gate-head{justify-content:center}
html .gate.full .gate-title{margin:0}
/* ⑥ 휴대폰 — 머리글 + 진행 레일이 화면 위 24%(201px)를 계속 가렸다 → 레일은 따라오지 않게, 요청 번호 · 지난 단계는 숨기고 지금 단계만 */
@media (max-width:560px){
  html .rail-wrap{position:static}
  html .rail .rid,html .rail .sep,html .rail .step:not(.now):not(.block):not(.hold):not(.has-info){display:none} /* 눌러서 펼치는 끝난 단계(결과 화면)는 남긴다(2026-10-01) */
}
</style>
