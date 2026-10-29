<script setup lang="ts">
// C5 판정 배지 — 읽기 전용(U6). 위험도는 글자 + 기호(●◐○) + 채움 모양 3중 표기(가이드 §5.2).
import { computed } from 'vue'
import { CATEGORY, CONFIDENCE, RISK_LEVEL, RISK_SYMBOL, RISK_TYPE } from '@/lib/labels'
import type { Confidence, DisplayCategory, RiskLevel, RiskType } from '@/api/types'

const props = withDefaults(
  defineProps<{
    category: DisplayCategory
    riskType?: RiskType | null
    riskLevel?: RiskLevel | null
    confidence?: Confidence | null
    evidenceUnconfirmed?: boolean
    expertReviewRecommended?: boolean
    lowOcrQuality?: boolean
    /** 판정 불가(잘못된 입력·계약 조항 아님·지시문) — 있으면 '판정 불가'와 사유를 보이고 '다시 분석 가능'은 숨긴다 */
    abstention?: { reason: string; label: string } | null
  }>(),
  { riskType: null, riskLevel: null, confidence: null, evidenceUnconfirmed: false, expertReviewRecommended: false, lowOcrQuality: false, abstention: null },
)

const catText = computed(() =>
  props.abstention ? '판단 보류' : props.evidenceUnconfirmed ? `${CATEGORY.dispute} · 근거를 못 찾음` : CATEGORY[props.category],
)
const isRisk = computed(() => props.category !== 'normal' && props.category !== 'unanalyzable')
</script>

<template>
  <div class="verdict" data-c="C5" :data-category="category" aria-label="판단 결과 (읽기 전용)" role="group">
    <span :class="['cat', { unanalyzable: category === 'unanalyzable' }]">{{ catText }}</span>
    <template v-if="isRisk">
      <span v-if="riskType" class="meta">{{ RISK_TYPE[riskType] }}</span>
      <span
        v-if="riskLevel"
        :class="['risk', riskLevel]"
        :data-level="riskLevel"
        :aria-label="`위험도 ${RISK_LEVEL[riskLevel]} (${RISK_SYMBOL[riskLevel]})`"
      >위험도 {{ RISK_LEVEL[riskLevel] }}</span>
      <span v-if="confidence" class="meta">확신 정도 {{ CONFIDENCE[confidence] }}</span>
    </template>
    <span v-if="evidenceUnconfirmed" class="aux">직접 한번 살펴봐 주세요</span>
    <span v-if="expertReviewRecommended" class="aux">전문가에게도 확인받아 보세요</span>
    <span v-if="lowOcrQuality" class="aux">글자가 흐릿해요</span>
    <span v-if="abstention" class="aux">{{ abstention.label }}</span>
    <span v-else-if="category === 'unanalyzable'" class="aux">다시 분석할 수 있어요</span>
  </div>
</template>
