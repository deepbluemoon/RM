// 로그인 세션·역할·권한(RBAC). 권한 판정 원천은 서버(GET /api/session 의 permissions) — 화면은 메뉴·라우트 가드에만 쓴다.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api/endpoints'
import type { Permission, SessionInfo, UserRole } from '@/api/types'

export interface MenuItem { to: string; label: string; perm: Permission; sub?: string }

/** 사용자 영역(UC1~UC6) — 역할 user */
export const USER_MENU: MenuItem[] = [
  { to: '/', label: '새 분석', perm: 'analysis.request', sub: '파일 · 웹 주소 · 글로 계약서를 넣어요' },
  { to: '/history', label: '분석 기록', perm: 'history.manage', sub: '지난 결과를 다시 보거나 지워요' },
]

/** 운영 영역(UC7~UC10) — SD_02 §2-2: 사용자 메뉴와 분리, 권한 없으면 메뉴 자체가 없다(G14).
 *  권한 관리(S10) 화면은 2026-09-30 요청으로 뺐다 — 역할은 운영자·사용자 두 가지로 고정 */
export const OPS_MENU: MenuItem[] = [
  { to: '/admin/knowledge', label: '근거 자료 관리', perm: 'knowledge.manage', sub: '법령 · 표준약관 · 공정위 사례 새로 받기' },
  { to: '/admin/eval', label: '품질 점검', perm: 'eval.run', sub: '탐지가 얼마나 잘 맞는지 확인' },
  { to: '/admin/eval/expert', label: '전문가 검토', perm: 'eval.review', sub: '점검용 정답 데이터 확인' },
  { to: '/admin/feedback', label: '이용자 의견 검토', perm: 'feedback.review', sub: '이용자가 보낸 판정 의견 처리' },
]

/** API 활용 — 사용자는 안내·키 발급만, 운영자는 서버 상태·운영 문서·전체 키 관리까지(modelApi.manage) */
export const API_MENU: Array<{ tab: string; label: string; sub: string; manage?: boolean }> = [
  { tab: 'endpoints', label: '기능 목록', sub: '쓸 수 있는 기능과 주고받는 값' },
  { tab: 'quickstart', label: '처음 써 보기', sub: 'curl · Python · JavaScript 예시로 바로 해 봐요' },
  { tab: 'keys', label: 'API 키', sub: '키를 만들고 필요 없으면 없애요' },
  { tab: 'guidelines', label: '이용 규칙', sub: '쓰기 전에 꼭 지켜 주세요' },
  { tab: 'manual', label: '운영 매뉴얼', sub: '켜기 · 점검 · 장애 대응', manage: true },
  { tab: 'status', label: '서버 상태', sub: '모델별 준비 상태', manage: true },
  { tab: 'docs', label: '문서 · 점검 결과', sub: '서비스 점검 · 보고서', manage: true },
]

export const ROLE_LABEL: Record<UserRole, string> = {
  user: '사용자',
  operator: '운영자',
  developer: '개발자',
  legal_expert: '법률 전문가',
}

export const useSessionStore = defineStore('session', () => {
  const info = ref<SessionInfo | null>(null)
  const loaded = ref(false)
  const failed = ref(false)
  let inflight: Promise<void> | null = null

  async function load(force = false): Promise<void> {
    if (loaded.value && !force) return
    if (inflight) return inflight
    inflight = (async () => {
      try {
        info.value = await api.session()
        failed.value = false
      } catch {
        info.value = null
        failed.value = true
      } finally {
        loaded.value = true
        inflight = null
      }
    })()
    return inflight
  }

  const loggedIn = computed(() => !!info.value?.loggedIn)
  const role = computed<UserRole | null>(() => info.value?.user?.role ?? null)
  const roleLabel = computed(() => (role.value ? ROLE_LABEL[role.value] : ''))
  const permissions = computed<readonly Permission[]>(() => info.value?.permissions ?? [])
  /** 운영자 화면(운영 메뉴가 있는 역할)인지 — 머리글·메뉴를 운영자 기준으로 바꾼다 */
  const isOperator = computed(() => role.value === 'operator' || role.value === 'developer' || role.value === 'legal_expert')
  const displayName = computed(() => info.value?.user?.nickname || '이름 없음')

  function can(perm: Permission | undefined): boolean {
    return !perm || permissions.value.includes(perm)
  }
  const userMenu = computed(() => USER_MENU.filter((m) => can(m.perm)))
  const opsMenu = computed(() => OPS_MENU.filter((m) => can(m.perm)))
  const apiMenu = computed(() => (can('modelApi.view') ? API_MENU.filter((a) => !a.manage || can('modelApi.manage')) : []))
  /** 로그인 직후·권한 없는 첫 화면 대신 보낼 곳 — 역할이 쓸 수 있는 첫 메뉴 */
  const homePath = computed(() => [...USER_MENU, ...OPS_MENU].find((m) => can(m.perm))?.to ?? (can('modelApi.view') ? '/api-guide' : '/forbidden'))

  /** 아이디·비밀번호 로그인·회원가입 — 성공하면 세션을 다시 읽는다. 실패는 호출한 화면이 문구로 보여 준다 */
  async function login(loginId: string, password: string, returnTo: string) {
    const r = await api.login(loginId, password, returnTo)
    await load(true)
    return r
  }
  async function signup(loginId: string, password: string, name: string, returnTo: string) {
    const r = await api.signup(loginId, password, name, returnTo)
    await load(true)
    return r
  }

  async function logout() {
    try {
      await api.logout()
    } finally {
      await load(true)
    }
  }

  return { info, loaded, failed, load, loggedIn, role, roleLabel, permissions, isOperator, displayName, can, userMenu, opsMenu, apiMenu, homePath, login, signup, logout }
})
