// <details> 부드럽게 열고 닫기(2026-10-01) — v-smooth-details.
// 기본 <details> 는 툭 열리고 툭 닫힌다. 요약(summary)을 누르면 기본 동작을 막고 높이를 Web Animations 로 움직인 뒤 open 을 바꾼다.
// · 열기: open = true → 닫힌 높이(요약 줄)에서 펼친 높이로 · 닫기: 펼친 높이에서 요약 높이로 줄인 뒤 open = false
// · 키보드(Enter · Space)도 summary 의 click 으로 들어와 같은 길을 탄다. toggle 이벤트는 그대로 나므로 기존 @toggle 처리도 그대로 돈다
// · 안쪽 details 는 자기 summary 만 처리한다(바깥 것은 이벤트 대상이 자기 summary 일 때만) · 모션 줄이기면 애니메이션 없이 바로
// · 열고 닫는 도중 다시 누르면 지금 높이에서 반대로 이어진다(끊김 없이)
import type { Directive } from 'vue'

const EASE = 'cubic-bezier(.22, 1, .36, 1)'
const OPEN_MS = 320
const CLOSE_MS = 240
const state = new WeakMap<HTMLDetailsElement, { anim: Animation | null; closing: boolean; onClick: (e: MouseEvent) => void }>()

const reduced = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function setup(el: HTMLDetailsElement) {
  const summary = el.querySelector(':scope > summary') as HTMLElement | null
  if (!summary) return
  // 여백 겹침 막기 — 움직이는 동안(overflow:hidden)은 안쪽 마지막 여백이 상자 안에 들어오고, 끝나면 밖으로 빠져 14px 튀었다(측정: 285→271).
  // 늘 flow-root 로 두면 움직일 때와 끝난 뒤 높이가 같다
  if (getComputedStyle(el).display === 'block') el.style.display = 'flow-root'
  const st = { anim: null as Animation | null, closing: false, onClick: (e: MouseEvent) => toggle(e) }
  state.set(el, st)

  function finish(open: boolean) {
    el.open = open
    st.anim = null
    st.closing = false
    delete el.dataset.closing
    el.style.height = ''
    el.style.overflow = ''
  }

  function toggle(e: MouseEvent) {
    if (reduced() || typeof el.animate !== 'function') return // 기본 동작 그대로
    e.preventDefault()
    const from = `${el.getBoundingClientRect().height}px`
    st.anim?.cancel()
    el.style.overflow = 'hidden'
    const opening = st.closing || !el.open
    if (opening) {
      el.style.height = from
      el.open = true
      const to = `${summary!.getBoundingClientRect().height + contentHeight(el, summary!)}px`
      st.closing = false
      delete el.dataset.closing
      st.anim = el.animate({ height: [from, to] }, { duration: OPEN_MS, easing: EASE })
      el.style.height = to // 끝난 순간 onfinish 전까지 한 프레임 동안 옛 높이로 튀지 않게(측정: 닫기에서 497→26→511→26)
      st.anim.onfinish = () => finish(true)
    } else {
      st.closing = true
      el.dataset.closing = '' // 닫히는 동안 표시(화살표는 바로 돌아가게) — open 은 애니메이션이 끝나야 false
      const to = `${summary!.getBoundingClientRect().height}px`
      st.anim = el.animate({ height: [from, to] }, { duration: CLOSE_MS, easing: EASE })
      el.style.height = to
      st.anim.onfinish = () => finish(false)
    }
  }

  summary.addEventListener('click', st.onClick)
}

/** 펼쳤을 때 summary 아래 내용 높이 — open 상태에서 실제 상자 높이로 잰다.
 *  scrollHeight 는 마지막 자식의 아래 여백까지 넣어 14px 크게 나와, 열린 뒤 줄어들며 튀었다(측정: 26→285→271) */
function contentHeight(el: HTMLDetailsElement, summary: HTMLElement): number {
  const prev = el.style.height
  el.style.height = 'auto'
  const full = el.getBoundingClientRect().height
  el.style.height = prev
  return Math.max(0, full - summary.getBoundingClientRect().height)
}

export const vSmoothDetails: Directive<HTMLDetailsElement> = {
  mounted: (el) => setup(el),
  beforeUnmount: (el) => {
    const st = state.get(el)
    if (!st) return
    st.anim?.cancel()
    el.querySelector(':scope > summary')?.removeEventListener('click', st.onClick as EventListener)
    state.delete(el)
  },
}
