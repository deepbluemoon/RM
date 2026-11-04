const switchLink = document.querySelector('.mode-switch')
let navigating = false
switchLink?.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
  if (navigating) event.preventDefault()
  navigating = true
})
addEventListener('pageshow', () => {
  navigating = false
  if ('CSSViewTransitionRule' in window || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const offset = document.documentElement.dataset.mode === 'monitor' ? '24px' : '-24px'
  document.body.animate([{ transform: 'translateX(' + offset + ')' }, { transform: 'translateX(0)' }], { duration: 220, easing: 'ease-out' })
})
