<script setup lang="ts">
// S7-O 이전 버전과 비교(UC8 A2·A4, 7.3) — 기록된 두 평가의 유형별 지표를 나란히. 변화는 부호 글자로(색 없음)
import { CONTRACT_TYPE } from '@/lib/labels'
import { ymd } from '@/lib/format'
import type { ContractType } from '@/api/types'

interface Side {
  evalRunId: number
  knowledgeDate?: string
  analysisBasisVersion?: string
  modelVersions?: { m1?: string; m2?: string; m3?: string }
}
interface Cell { recallPct: number | null; precisionPct: number | null; evidenceFitPct: number | null; measurable: boolean | null }
export interface CompareResult {
  a: Side
  b: Side
  modelChanged?: boolean
  knowledgeChanged?: boolean
  rows: { contractType: string; a: Cell | null; b: Cell | null; delta: { recallPp: number | null; precisionPp: number | null; evidenceFitPp: number | null } }[]
}

defineProps<{ result: CompareResult }>()

function v(c: Cell | null, k: 'recallPct' | 'precisionPct' | 'evidenceFitPct'): string {
  if (!c) return '평가 없음'
  if (c.measurable === false) return '측정할 수 없음'
  return c[k] == null ? (k === 'evidenceFitPct' ? '전문가 검토 대기' : '측정할 수 없음') : `${c[k]}%`
}
function d(n: number | null): string {
  if (n == null) return ''
  return n === 0 ? '(±0)' : n > 0 ? `(+${n}%p)` : `(−${Math.abs(n)}%p)`
}
const head = (s: Side) => `EV-${s.evalRunId} · 근거 자료 기준일 ${ymd(s.knowledgeDate)} · M3 최종 판단 모델 ${s.modelVersions?.m3 ?? ''}`
</script>

<template>
  <div class="stack sm" data-part="compare">
    <p class="t-body-sm charcoal">
      A = {{ head(result.a) }}<br />B = {{ head(result.b) }}
      <template v-if="result.modelChanged"><br /><strong>모델을 바꾸기 전과 후를 비교합니다</strong></template>
      <template v-if="result.knowledgeChanged"><br /><strong>두 평가의 근거 자료 기준일이 다릅니다</strong></template>
    </p>
    <div class="tablewrap">
      <table class="spec">
        <thead><tr><th>계약 유형</th><th>재현율(놓치지 않은 비율) A → B</th><th>정밀도(맞게 찾은 비율) A → B</th><th>근거 적합률(근거가 맞는 비율) A → B</th></tr></thead>
        <tbody>
          <tr v-for="r in result.rows" :key="r.contractType">
            <td>{{ CONTRACT_TYPE[r.contractType as ContractType] ?? r.contractType }}</td>
            <td>{{ v(r.a, 'recallPct') }} → {{ v(r.b, 'recallPct') }} {{ d(r.delta.recallPp) }}</td>
            <td>{{ v(r.a, 'precisionPct') }} → {{ v(r.b, 'precisionPct') }} {{ d(r.delta.precisionPp) }}</td>
            <td>{{ v(r.a, 'evidenceFitPct') }} → {{ v(r.b, 'evidenceFitPct') }} {{ d(r.delta.evidenceFitPp) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
