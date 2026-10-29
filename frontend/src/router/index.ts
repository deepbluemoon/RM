// T038 라우트 S0~S9 + 로그인(RBAC). 모든 화면은 로그인 필요(public 제외), meta.perm 이 있으면 그 권한이 있어야 연다.
// 권한 판정 원천은 서버(rbac.ts) — 여기 가드는 화면 이동만 막고, API 는 서버가 다시 막는다(G8 401·G14 403).
import { createRouter, createWebHistory, type RouterHistory, type RouteRecordRaw } from 'vue-router'
import type { Permission } from '@/api/types'
import { useSessionStore } from '@/stores/session'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    ops?: boolean
    /** 로그인 없이 연다 */
    public?: boolean
    /** 필요한 권한(유스케이스) */
    perm?: Permission
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'intake', component: () => import('@/views/S1Intake.vue'), alias: '/analyze', meta: { title: '새 분석', perm: 'analysis.request' } },
  { path: '/analyses/:requestId/structuring', name: 'structuring', component: () => import('@/views/S2Structuring.vue'), props: true, meta: { title: '개인정보 가리기 · 조항 나누기', perm: 'analysis.request' } },
  { path: '/analyses/:requestId/detection', name: 'detection', component: () => import('@/views/S3Detection.vue'), props: true, meta: { title: '위험 조항 찾기', perm: 'analysis.request' } },
  { path: '/results/:runId', name: 'result', component: () => import('@/views/S4Result.vue'), props: true, meta: { title: '분석 결과', perm: 'result.view' } },
  { path: '/history', name: 'history', component: () => import('@/views/S6History.vue'), meta: { title: '분석 기록', perm: 'history.manage' } },
  { path: '/admin/knowledge', name: 'knowledge', component: () => import('@/views/S0Knowledge.vue'), meta: { title: '근거 자료 관리', ops: true, perm: 'knowledge.manage' } },
  { path: '/admin/eval', name: 'eval', component: () => import('@/views/S7EvalOperator.vue'), meta: { title: '품질 점검', ops: true, perm: 'eval.run' } },
  { path: '/admin/eval/expert', name: 'eval-expert', component: () => import('@/views/S7EvalExpert.vue'), meta: { title: '전문가 검토', ops: true, perm: 'eval.review' } },
  { path: '/admin/feedback', name: 'feedback-review', component: () => import('@/views/S8FeedbackReview.vue'), meta: { title: '이용자 의견 검토', ops: true, perm: 'feedback.review' } },
  { path: '/api-guide', name: 'model-api', alias: '/admin/model-api', component: () => import('@/views/S9ApiGuide.vue'), meta: { title: 'API 활용', perm: 'modelApi.view' } },
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: '로그인', public: true } },
  { path: '/forbidden', name: 'forbidden', component: () => import('@/views/Forbidden.vue'), meta: { title: '접근 권한 없음' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFound.vue'), meta: { title: '찾을 수 없음', public: true } },
]

export function makeRouter(history: RouterHistory = createWebHistory()) {
  const router = createRouter({
    history,
    routes,
    scrollBehavior(to, from, saved) {
      if (saved) return saved
      if (to.path === from.path) return false // 같은 화면 안 탭 · 쿼리만 바뀜 — 제자리
      // 새 화면은 맨 위에서 바로 시작 — html 의 scroll-behavior:smooth 를 따라 긴 페이지를 위로 굴러 올라가며 바뀌던 것(2026-10-01)
      return { top: 0, behavior: 'instant' }
    },
  })
  router.beforeEach(async (to) => {
    const session = useSessionStore()
    await session.load()
    if (to.meta.public) return true
    if (!session.loggedIn) return { name: 'login', query: { returnTo: to.fullPath } }
    if (session.can(to.meta.perm)) return true
    // 첫 화면(새 분석)을 쓸 수 없는 역할(운영자·개발자·법률 전문가)은 자기 첫 메뉴로 보낸다
    if (to.name === 'intake') return session.homePath
    return { name: 'forbidden', query: { from: to.fullPath } }
  })
  router.afterEach((to) => {
    document.title = to.meta.title ? `${to.meta.title} · ReadMe` : 'ReadMe'
  })
  return router
}
