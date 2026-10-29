// v-if 로 생기고 없어지는 판을 높이째 부드럽게(2026-10-01) — <Transition :css="false" v-bind="smoothHeight">.
// 투명도만 바꾸면 판이 생기는 순간 아래 내용이 툭 밀려 내려가고, 닫히면 툭 올라온다 → 높이 · 위아래 여백 · 안쪽 여백을 0 에서 제 값으로 함께 움직인다.
// Web Animations 라 CSS 를 건드리지 않고, 끝나면 인라인 스타일이 남지 않는다. 도중에 반대로 바뀌면 Vue 가 앞 애니메이션의 done 을 부르고 새로 시작한다.
// 모션 줄이기면 애니메이션 없이 바로(smoothDetails 와 같은 곡선 · 길이)
const EASE = 'cubic-bezier(.22, 1, .36, 1)'
const OPEN_MS = 320
const CLOSE_MS = 240
const anims = new WeakMap<Element, Animation>()

const reduced = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function run(el: Element, opening: boolean, done: () => void) {
  const h = el as HTMLElement
  const now = h.getBoundingClientRect().height // 닫는 도중이면 지금 높이에서 이어서 줄인다
  anims.get(h)?.cancel()
  if (reduced() || typeof h.animate !== 'function') return done()
  const cs = getComputedStyle(h)
  const full = {
    height: `${opening ? h.getBoundingClientRect().height : now}px`,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    opacity: 1,
  }
  const zero = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 }
  h.style.overflow = 'hidden'
  h.style.boxSizing = 'border-box' // 잰 높이(테두리 · 안쪽 여백 포함)와 같은 기준으로 움직인다
  const a = h.animate(opening ? [zero, full] : [full, zero], { duration: opening ? OPEN_MS : CLOSE_MS, easing: EASE, fill: 'forwards' })
  anims.set(h, a)
  const end = () => {
    if (anims.get(h) !== a) return
    anims.delete(h)
    h.style.overflow = ''
    h.style.boxSizing = ''
    done()
    a.cancel() // fill 은 done(요소 제거 · 열기 끝) 다음에 풀어 마지막 한 프레임 튐을 막는다
  }
  a.onfinish = end
  a.oncancel = () => { if (anims.get(h) === a) { anims.delete(h); h.style.overflow = ''; h.style.boxSizing = '' } }
}

export const smoothHeight = {
  onEnter: (el: Element, done: () => void) => run(el, true, done),
  onLeave: (el: Element, done: () => void) => run(el, false, done),
}
