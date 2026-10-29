<script setup lang="ts">
// 권한 없는 화면(G14) — RBAC. 라우트 가드가 권한이 없는 화면 대신 여기로 보낸다. C2 접근 차단형(full)
// 막힌 이유를 쉬운 말로 풀어 쓴다: 연 화면 · 필요한 기능 · 지금 역할 · 푸는 방법(운영자에게 요청 또는 다른 계정으로 로그인).
// 게이트 제목은 SD_02 §14-2 문구 그대로 두고 사유 · 다음 행동만 채운다.
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import { gateFromCode } from '@/lib/gates'
import { useSessionStore } from '@/stores/session'
import type { Permission } from '@/api/types'

const session = useSessionStore()
const route = useRoute()
const router = useRouter()

// 권한 → 이름 · 가진 역할(운영자 · 사용자 두 부류, 2026-09-30)
const PERM_INFO: Record<string, { label: string; roles: string }> = {
  'analysis.request': { label: '계약서 분석', roles: '사용자' },
  'result.view': { label: '분석 결과 보기', roles: '사용자' },
  'explanation.view': { label: '위험 설명 · 근거 보기', roles: '사용자' },
  'history.manage': { label: '분석 기록 관리', roles: '사용자' },
  'feedback.submit': { label: '판단에 의견 보내기', roles: '사용자' },
  'knowledge.manage': { label: '근거 자료 관리', roles: '운영자' },
  'eval.run': { label: '품질 점검', roles: '운영자' },
  'eval.review': { label: '전문가 검토', roles: '운영자' },
  'feedback.review': { label: '이용자 의견 검토', roles: '운영자' },
  'modelApi.view': { label: 'API 활용', roles: '사용자 · 운영자' },
  'modelApi.manage': { label: 'API 서버 관리', roles: '운영자' },
}

const from = computed(() => {
  const f = route.query.from
  const v = Array.isArray(f) ? f[0] : f
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : null
})
const target = computed(() => (from.value ? router.resolve(from.value) : null))
const perm = computed(() => target.value?.meta.perm as Permission | undefined)
const info = computed(() => (perm.value ? PERM_INFO[perm.value] : undefined))
const screen = computed(() => target.value?.meta.title ?? '이 화면')

const gate = computed(() =>
  gateFromCode('G14', {
    reason: info.value
      ? `'${screen.value}' 화면은 ${info.value.roles} 계정만 열 수 있어요. 지금 계정은 ${session.roleLabel || '역할 없음'}이에요`
      : `지금 계정(${session.roleLabel || '역할 없음'})으로는 열 수 없는 화면이에요`,
    nextActions: [
      ...(session.homePath === '/forbidden' ? [] : [{ id: 'home', label: '내 첫 화면으로' }]),
      { id: 'switch', label: '다른 계정으로 로그인' },
    ],
  }),
)
async function onAction(id: string) {
  if (id === 'home') return void router.push(session.homePath)
  if (id === 'switch') {
    await session.logout()
    await router.replace({ name: 'login', query: from.value ? { returnTo: from.value } : {} })
  }
}
</script>

<template>
  <div class="page narrow">
    <div class="section tight">
      <C2GateBlock :gate="gate" full @action="onAction">
          <div class="forbid-help" data-part="g14-help">
            <p class="t-body-sm-strong m-0">이렇게 풀 수 있어요</p>
            <ul class="bullets">
              <li v-if="info">이 화면은 보통 <strong>{{ info.roles }}</strong> 역할이 열 수 있어요. 그 역할의 계정이 있다면 “다른 계정으로 로그인”을 눌러 주세요.</li>
              <li>내 계정에 이 기능이 필요하다면 운영자에게 요청해 주세요.</li>
            </ul>
          </div>
      </C2GateBlock>
    </div>
  </div>
</template>

<style scoped>
.forbid-help { text-align: left; max-width: 520px; margin: 0 auto var(--spacing-lg); padding: var(--spacing-lg); border-radius: var(--rounded-md); background: var(--color-surface-soft); display: grid; gap: var(--spacing-sm); }
</style>
