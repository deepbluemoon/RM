let ring
export function beginActionProgress(button) {
 ring?.remove(); ring=document.createElement('div');ring.className='action-progress';ring.setAttribute('role','status');ring.setAttribute('aria-live','polite')
 ring.innerHTML='<svg viewBox="0 0 48 48" aria-hidden="true"><circle class="progress-track" cx="24" cy="24" r="19"/><circle class="progress-gauge" cx="24" cy="24" r="19" pathLength="100"/></svg><span>실행 중<small>서버 응답 대기 · 실제 진행률은 제공되지 않습니다</small></span>'
 button.closest('.action-dialog-buttons').before(ring);button.setAttribute('aria-busy','true');ring.button=button
}
export async function endActionProgress(success) {
 if(!ring)return
 const current=ring;current.classList.add(success?'is-complete':'is-failed');current.querySelector('span').textContent=success?'실행 완료':'실행 실패';current.button.removeAttribute('aria-busy')
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches)await new Promise(resolve=>setTimeout(resolve,450))
 current.remove();if(ring===current)ring=null
}
