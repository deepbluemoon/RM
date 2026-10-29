// S2·S3 공통 — 서버 rail(FR-024 세부 줄)을 C1 세부 줄 모양으로 바꾼다.
import type { AnalysisStatus } from '@/api/types'
import { SUB_STEP_LABEL } from '@/lib/labels'
import type { RailSub } from '@/components/common/C1Rail.vue'

const ORDER = ['received', 'deidentify', 'structure', 'detect', 'search', 'explain'] as const

export function railDetail(s: AnalysisStatus | null): RailSub[] {
  const rail = s?.rail ?? []
  return ORDER.map((step) => {
    const r = rail.find((x) => x.step === step)
    return { label: SUB_STEP_LABEL[step], state: (r?.state ?? 'waiting') as RailSub['state'] }
  })
}

export const EXPECTED_TEXT = '보통 1~3분 걸려요. 처음 분석이면 준비하느라 조금 더 걸릴 수 있어요'
