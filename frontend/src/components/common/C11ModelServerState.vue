<script setup lang="ts">
// C11 모델 서버 상태 표시 — 상태 + 조회 시각 + 수동 새로고침(자동 새로고침 없음, SD_02 §1-1).
// 공유 Ollama 는 5분 유휴 후 모델을 내리므로 ready 여도 coldStart 이면 첫 분석에 준비 시간이 더 든다(G5 아님).
// compact(S1, 2026-09-30): 쉬는 중(cold)은 막는 상황이 아니므로 새로고침 버튼 · 조회 시각 없이 한 줄로만 알린다. 다른 상태는 그대로.
import { computed } from 'vue'
import { hm } from '@/lib/format'

export type ServerState = 'ready' | 'loading' | 'unreachable' | 'auth_mismatch' | 'not_implemented'
export interface ServerStatusLike {
  state: ServerState
  checkedAt: string
  coldStart?: boolean
  warmupEstimateSec?: number | null
  httpStatus?: number | null
}

const props = withDefaults(
  defineProps<{ status: ServerStatusLike | null; loading?: boolean; failed?: boolean; admin?: boolean; compact?: boolean }>(),
  { loading: false, failed: false, admin: false, compact: false },
)
const emit = defineEmits<{ refresh: [] }>()

const view = computed(() => {
  const s = props.status
  if (!s) return null
  const cold = s.state === 'ready' && !!s.coldStart
  const cls =
    s.state === 'ready' ? (cold ? 'cold' : 'ready') :
    s.state === 'loading' ? 'loading' :
    s.state === 'auth_mismatch' ? 'key' : 'down'
  const code = props.admin && s.httpStatus ? ` ${s.httpStatus}` : ''
  let text = ''
  let note = ''
  switch (s.state) {
    case 'ready':
      text = cold ? '잠시 쉬는 중' : '바로 분석할 수 있어요'
      note = cold
        ? `지금 바로 시작할 수 있어요. 한동안 쉬고 있었기 때문에 첫 분석만 ${s.warmupEstimateSec ? `약 ${s.warmupEstimateSec}초` : '조금'} 더 걸려요.`
        : ''
      break
    case 'loading':
      text = `분석 준비 중${code}`
      note = `분석을 준비하고 있어요. ${s.warmupEstimateSec ? `약 ${s.warmupEstimateSec}초` : '보통 10~30초'}면 끝나요. 잠시 뒤 상태를 다시 확인해 주세요.`
      break
    case 'unreachable':
      text = `연결 안 됨${code}`
      note = props.admin ? '모델 서버가 응답하지 않습니다. 모델 서버가 켜져 있는지 확인하세요.' : '지금은 분석 서버에 연결되지 않아서 분석을 시작할 수 없어요. 잠시 뒤 다시 확인해 주세요.'
      break
    case 'auth_mismatch':
      text = `접속 키가 맞지 않음${code}`
      note = '모델 서버 접속 키(API 키)가 서로 다릅니다. 키는 서버 설정 파일(환경변수)에서만 바꿀 수 있고 화면에는 보여 주지 않습니다.'
      break
    case 'not_implemented':
      text = '상태 확인 기능 없음'
      note = '모델 서버에 상태 확인 기능(/health)이 없습니다. 운영 매뉴얼의 상태 확인 명령으로 직접 확인하세요.'
      break
  }
  return { cls, text, note, cold }
})
</script>

<template>
  <div class="status-block" data-c="C11" :data-state="status?.state ?? (failed ? 'failed' : 'none')" :data-cold="view?.cold ? 'true' : undefined">
    <p v-if="compact && view?.cold" class="status-inline m-0">
      <span :class="['status', view.cls]"><i aria-hidden="true" /><span class="state-text">{{ view.text }}</span></span>
      <span class="status-note" data-part="note">{{ view.note }}</span>
    </p>
    <template v-else>
    <div class="row">
      <span v-if="view" :class="['status', view.cls]">
        <i aria-hidden="true" />
        <span class="state-text">{{ view.text }}</span>
        <time :datetime="status!.checkedAt">확인 시각 {{ hm(status!.checkedAt) }}</time>
      </span>
      <span v-else-if="failed" class="status down"><i aria-hidden="true" /><span class="state-text">상태를 확인하지 못했어요</span></span>
      <span v-else class="status"><span class="muted">상태를 확인하고 있어요…</span></span>
      <button type="button" class="btn btn-secondary" data-action="refresh" :aria-busy="loading ? 'true' : undefined" @click="emit('refresh')">
        {{ loading ? '확인 중…' : '상태 다시 확인' }}
      </button>
    </div>
    <p v-if="view?.note" class="status-note" data-part="note">{{ view.note }}</p>
    </template>
  </div>
</template>

