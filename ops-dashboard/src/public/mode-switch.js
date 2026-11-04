// Native cross-document transitions preserve normal links and browser history.
// Older browsers receive a short exit motion before normal navigation.
if (!('CSSViewTransitionRule' in window)) {
  let leaving = false
  document.querySelectorAll('.mode-switch a').forEach(link => link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    event.preventDefault()
    if (leaving) return
    leaving = true
    document.body.animate([{opacity:1,transform:'translateX(0)'},{opacity:0,transform:`translateX(${document.documentElement.dataset.mode === 'monitor' ? '12%' : '-12%'})`}],{duration:220,easing:'ease-in',fill:'forwards'}).finished.then(()=>location.assign(link.href))
  }))
  addEventListener('pageshow',()=>{leaving=false;document.body.getAnimations().forEach(animation=>animation.cancel())})
}
