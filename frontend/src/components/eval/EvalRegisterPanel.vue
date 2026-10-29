<script setup lang="ts">
// S7-O 평가 데이터 등록(SD_02 §11-2, UC8 A1 · UC9 A2) — 새 라벨링 조항과 피드백 후보(H5)를 등록한다.
// 등록한 조항은 법률 전문가 검수(S7-E) 전에는 평가 데이터가 아니다(BR-QA-01). 입력 텍스트는 서버에서 다시 비식별화한다.
import { ref } from 'vue'
import { http } from '@/api/client'
import { CATEGORY, CONTRACT_TYPE, CONTRACT_TYPES } from '@/lib/labels'
import { ymd } from '@/lib/format'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import type { ContractType } from '@/api/types'

export interface EvalCandidateRow { candidateId: number; contractType: ContractType; candidateAt?: string; clauseTextDeid: string }
type Gold = 'normal' | 'dispute' | 'unfair' | 'illegal'
const GOLDS: Gold[] = ['normal', 'dispute', 'unfair', 'illegal']

const props = defineProps<{ candidates: EvalCandidateRow[] }>()
const emit = defineEmits<{ registered: [] }>()

const text = ref('')
const contractType = ref<ContractType>('subscription')
const gold = ref<Gold>('unfair')
const origin = ref<'new_label' | 'synthetic'>('new_label')
const overlaps = ref(false)
const candGold = ref<Record<number, Gold>>({})
const busy = ref<string | null>(null)
const msg = ref<string | null>(null)

async function registerNew() {
  if (!text.value.trim()) {
    msg.value = '조항 글을 입력하세요'
    return
  }
  busy.value = 'new'
  msg.value = null
  try {
    const r = await http.post<{ evalItemId: number; maskedTypes?: string[] }>('/admin/eval/items', {
      clauseTextDeid: text.value,
      contractType: contractType.value,
      goldCategory: gold.value,
      origin: origin.value,
      overlapsTraining: overlaps.value,
    })
    text.value = ''
    overlaps.value = false
    msg.value = `평가 데이터 ${r.evalItemId}번을 등록했습니다 - 법률 전문가 검토를 기다립니다${r.maskedTypes?.length ? ' (개인정보를 가려 저장했습니다)' : ''}`
    emit('registered')
  } catch {
    msg.value = '등록하지 못했습니다 - 입력을 확인하고 다시 시도하세요'
  } finally {
    busy.value = null
  }
}

async function promote(c: EvalCandidateRow) {
  const g = candGold.value[c.candidateId]
  if (!g) {
    msg.value = '후보에 붙일 정답을 고르세요'
    return
  }
  busy.value = `c-${c.candidateId}`
  msg.value = null
  try {
    await http.post('/admin/eval/items', { clauseTextDeid: '', contractType: c.contractType, goldCategory: g, origin: 'feedback_candidate', candidateId: c.candidateId })
    msg.value = `이용자 의견 후보 ${c.candidateId}번을 평가 데이터로 등록했습니다 - 법률 전문가 검토를 기다립니다`
    emit('registered')
  } catch {
    msg.value = '후보를 등록하지 못했습니다 - 다시 시도하세요'
  } finally {
    busy.value = null
  }
}
void props
</script>

<template>
  <div class="stack" data-part="eval-register">
    <p v-if="msg" role="status" class="t-body-sm">{{ msg }}</p>
    <form class="card stack sm" aria-labelledby="new-label-h" @submit.prevent="registerNew">
      <h3 id="new-label-h" class="t-body-strong">정답을 새로 붙인 조항 등록</h3>
      <label class="t-body-sm" for="ev-text">조항 글(개인정보를 가린 글)</label>
      <textarea id="ev-text" v-model="text" class="text-input" rows="3" maxlength="5000" />
      <div class="row">
        <label class="t-body-sm">계약 유형
          <select v-model="contractType" class="text-input w-auto">
            <option v-for="t in CONTRACT_TYPES" :key="t" :value="t">{{ CONTRACT_TYPE[t] }}</option>
          </select>
        </label>
        <label class="t-body-sm">정답(판단 결과)
          <select v-model="gold" class="text-input w-auto">
            <option v-for="g in GOLDS" :key="g" :value="g">{{ CATEGORY[g] }}</option>
          </select>
        </label>
        <label class="t-body-sm">어디서 왔나
          <select v-model="origin" class="text-input w-auto">
            <option value="new_label">새로 정답을 붙인 문장</option>
            <option value="synthetic">일부러 바꿔 만든 문장(학습에만 쓰고 평가에는 빠짐)</option>
          </select>
        </label>
        <label class="choice"><input v-model="overlaps" type="checkbox" /> 모델 학습에 이미 쓴 문장</label>
      </div>
      <div><button type="submit" class="btn btn-secondary" :aria-busy="busy === 'new' ? 'true' : undefined">{{ busy === 'new' ? '처리 중…' : '등록하고 전문가 검토 요청' }}</button></div>
    </form>

    <section class="card stack sm" aria-labelledby="cand-h">
      <h3 id="cand-h" class="t-body-strong">이용자 의견에서 온 후보(H5) {{ candidates.length }}건</h3>
      <C7AreaPlaceholder v-if="!candidates.length" kind="na" text="등록을 기다리는 의견 후보가 없습니다 - '이용자 의견 검토'에서 '의견이 맞음'으로 판단한 의견을 넘기면 여기에 나타납니다" />
      <div v-else class="tablewrap">
        <table class="spec" data-part="candidates">
          <thead><tr><th>조항</th><th>계약 유형</th><th>넘긴 날</th><th>붙일 정답</th><th /></tr></thead>
          <tbody>
            <tr v-for="c in candidates" :key="c.candidateId">
              <td class="cell-wide"><C8Masked :text="c.clauseTextDeid" /></td>
              <td>{{ CONTRACT_TYPE[c.contractType] ?? c.contractType }}</td>
              <td>{{ ymd(c.candidateAt) }}</td>
              <td>
                <label class="visually-hidden" :for="`cg-${c.candidateId}`">붙일 정답</label>
                <select :id="`cg-${c.candidateId}`" v-model="candGold[c.candidateId]" class="text-input w-auto">
                  <option :value="undefined" disabled>고르세요</option>
                  <option v-for="g in GOLDS" :key="g" :value="g">{{ CATEGORY[g] }}</option>
                </select>
              </td>
              <td><button type="button" class="btn btn-secondary" :aria-busy="busy === `c-${c.candidateId}` ? 'true' : undefined" @click="promote(c)">등록</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
