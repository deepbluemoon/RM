<script setup lang="ts">
// S5 판정 피드백 제출 (SD_02 §9) — T120. S4 위 패널. 판정은 바뀌지 않는다(U6).
// 유형은 대상 판정으로 자동 제한, 의견은 저장 전 비식별 미리보기(C8), 닫히면 같은 조항으로 포커스 복귀.
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import { CATEGORY, RISK_LEVEL } from '@/lib/labels'
import { ymd } from '@/lib/format'
import C1Rail, { type RailStep } from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton, { type DisabledReason } from '@/components/common/C3ReasonButton.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import type { ClauseDetail, ClauseNode } from '@/api/types'

const props = defineProps<{
  open: boolean
  clause: ClauseNode | null
  detail: ClauseDetail | null
  knowledgeDate: string
  returnFocus?: () => void
}>()
const emit = defineEmits<{ close: [] }>()
const router = useRouter()

type FbType = 'false_positive' | 'false_negative'
const fbType = ref<FbType | null>(null)
const opinion = ref('')
const preview = ref<string | null>(null)
const previewing = ref(false)
const submitting = ref(false)
const gate = ref<GateView | null>(null)
const saveFailed = ref(false)
const done = ref<string | null>(null)
const titleEl = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

const allowed = computed<FbType>(() => {
  if (props.detail?.feedbackTypeAllowed) return props.detail.feedbackTypeAllowed
  const c = props.clause?.displayCategory
  return c === 'normal' || c === 'unanalyzable' ? 'false_negative' : 'false_positive'
})

watch(
  () => props.open,
  async (o) => {
    if (o) {
      fbType.value = allowed.value
      opinion.value = ''
      preview.value = null
      gate.value = null
      saveFailed.value = false
      done.value = null
      await nextTick()
      titleEl.value?.focus()
    }
  },
  { immediate: true },
)

watch(opinion, (v) => {
  if (timer) clearTimeout(timer)
  if (!v.trim()) {
    preview.value = null
    return
  }
  timer = setTimeout(async () => {
    previewing.value = true
    try {
      preview.value = (await api.feedbackPreview(v)).opinionDeid ?? null
    } catch {
      preview.value = null
    } finally {
      previewing.value = false
    }
  }, 400)
})
onUnmounted(() => timer && clearTimeout(timer))

const step = computed(() => (done.value ? 4 : opinion.value.trim() ? 3 : fbType.value ? 2 : 1))
const railSteps = computed<RailStep[]>(() =>
  ['조항 확인', '의견 종류', '의견 쓰기', '보내기'].map((label, i) => {
    const n = i + 1
    if (n === 4 && gate.value) return { label, state: 'block', gate: gate.value.gate }
    if (done.value) return { label, state: 'done' }
    return { label, state: n < step.value + 1 ? 'done' : n === step.value + 1 ? 'now' : 'wait' }
  }),
)

const submitReason = computed<DisabledReason | null>(() => {
  if (gate.value) return { gate: gate.value.gate, text: gate.value.title }
  if (done.value) return { text: '이미 보냈어요' }
  if (!fbType.value) return { text: '먼저 의견 종류를 골라 주세요' }
  if (opinion.value.trim() && previewing.value) return { text: '개인정보를 가린 미리보기를 만들고 있어요' }
  return null
})

async function submit() {
  if (!props.clause || !fbType.value) return
  submitting.value = true
  saveFailed.value = false
  try {
    const r = await api.submitFeedback({
      assessmentId: props.clause.assessmentId,
      feedbackType: fbType.value,
      opinion: opinion.value.trim() || undefined,
    })
    done.value = r.notice ?? '의견 고마워요! 판단 결과가 바로 바뀌지는 않고, 운영자가 살펴본 뒤 반영해요'
  } catch (e) {
    if (e instanceof GateApiError) gate.value = toGateView(e.body)
    else saveFailed.value = true // 게이트 아님 — 입력 유지 + 다시 시도(UC6 E3)
  } finally {
    submitting.value = false
  }
}

function close() {
  emit('close')
  nextTick(() => props.returnFocus?.())
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}
function onGate(a: string) {
  if (a === 'new_analysis') router.push('/')
}
const clauseTitle = computed(() => {
  const c = props.clause
  if (!c) return ''
  return [c.articleNo, c.title].filter(Boolean).join(' ') || `조항 ${c.seq}`
})
</script>

<template>
  <Transition name="scrim-fade"><div v-if="open" class="scrim open" @click="close" /></Transition>
  <Transition name="drawer-slide">
  <aside v-if="open" class="drawer open" role="dialog" aria-modal="true" aria-labelledby="s5-title" data-view="S5" @keydown="onKey">
    <header>
      <h4 id="s5-title" ref="titleEl" tabindex="-1">이 판단에 의견 보내기</h4>
      <button type="button" class="btn btn-secondary" @click="close">닫기</button>
    </header>
    <!-- 진행 단계는 내용을 내려도 창 위쪽에 고정된다(2026-09-30) — 스크롤 영역 밖에 둔다 -->
    <div class="panel-rail" data-part="panel-rail">
      <C1Rail :steps="railSteps" :sticky="false" />
    </div>
    <div class="body panel-body">
      <div class="band" data-c="C4">
        <span>의견을 보낼 조항 <strong>{{ clauseTitle }}</strong></span>
        <span v-if="clause">판단 <strong>{{ CATEGORY[clause.displayCategory] }}</strong></span>
        <span v-if="clause?.riskLevel">위험도 <strong>{{ RISK_LEVEL[clause.riskLevel] }}</strong></span>
        <span>근거 자료 기준일 <strong>{{ ymd(knowledgeDate) }}</strong></span>
      </div>

      <fieldset class="card m-0">
        <legend class="t-body-sm-strong">의견 종류 <span class="t-caption-sm muted">(이 조항의 판단에 따라 고를 수 있는 게 달라요)</span></legend>
        <div class="stack sm mt-sm">
          <label class="choice" :aria-disabled="allowed !== 'false_positive' ? 'true' : undefined">
            <input v-model="fbType" type="radio" name="fbtype" value="false_positive" :disabled="allowed !== 'false_positive'" aria-describedby="fb-fp-why" />
            위험하지 않은데 위험으로 표시됨
          </label>
          <span v-if="allowed !== 'false_positive'" id="fb-fp-why" class="reason">위험하다고 판단한 조항에서만 고를 수 있어요</span>
          <label class="choice" :aria-disabled="allowed !== 'false_negative' ? 'true' : undefined">
            <input v-model="fbType" type="radio" name="fbtype" value="false_negative" :disabled="allowed !== 'false_negative'" aria-describedby="fb-fn-why" />
            위험한데 놓친 조항
          </label>
          <span v-if="allowed !== 'false_negative'" id="fb-fn-why" class="reason">'정상'이나 '판단 어려움'으로 나온 조항에서만 고를 수 있어요</span>
        </div>
      </fieldset>

      <div class="stack sm">
        <label for="fb-opinion" class="t-body-sm-strong">의견 <span class="t-caption-sm muted">(쓰지 않아도 괜찮아요)</span></label>
        <textarea id="fb-opinion" v-model="opinion" class="text-area minh-sm" maxlength="2000" :readonly="!!done" />
        <p class="t-caption-sm muted">적은 내용에 개인정보가 있으면 저장하기 전에 가려요. 아래 미리보기 그대로 저장돼요.</p>
        <div v-if="opinion.trim()" class="preview" data-part="preview" aria-live="polite">
          <span v-if="previewing && !preview">개인정보를 가린 미리보기를 만들고 있어요…</span>
          <C8Masked v-else-if="preview" :text="preview" />
          <span v-else>미리보기를 만들지 못했어요. 보내면 서버에서 개인정보를 한 번 더 가려요.</span>
        </div>
      </div>

      <C2GateBlock v-if="gate" :gate="gate" @action="onGate" />
      <p v-if="saveFailed" role="alert" class="t-body-sm">저장하지 못했어요. 적은 내용은 그대로 있으니 다시 시도해 주세요.</p>
      <p v-if="done" role="status" class="card t-body-sm m-0" data-part="done">{{ done }}</p>

      <div class="row justify-end">
        <button type="button" class="btn btn-secondary" @click="close">{{ done ? '닫기' : '취소' }}</button>
        <C3ReasonButton label="보내기" :reason="submitReason" :busy="submitting" busy-label="보내고 있어요…" @click="submit" />
      </div>
    </div>
  </aside>
  </Transition>
</template>
