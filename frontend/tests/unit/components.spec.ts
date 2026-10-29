// T145 — C1~C11·D1 상태별 스냅샷과 접근성(SD_02 §15-2)
import { describe, it, expect, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, defineComponent, h, ref } from 'vue'
import C1Rail from '@/components/common/C1Rail.vue'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C3ReasonButton from '@/components/common/C3ReasonButton.vue'
import C4BasisBand from '@/components/common/C4BasisBand.vue'
import C5VerdictBadge from '@/components/common/C5VerdictBadge.vue'
import C6EvidenceChip from '@/components/common/C6EvidenceChip.vue'
import C7AreaPlaceholder from '@/components/common/C7AreaPlaceholder.vue'
import C8Masked from '@/components/common/C8Masked.vue'
import C9ImpactBand from '@/components/common/C9ImpactBand.vue'
import C11ModelServerState from '@/components/common/C11ModelServerState.vue'
import D1SourceDrawer from '@/components/common/D1SourceDrawer.vue'
import ProgressWaitLine from '@/components/common/ProgressWaitLine.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import DeleteConfirm from '@/components/common/DeleteConfirm.vue'
import CancelAnalysisDialog from '@/components/common/CancelAnalysisDialog.vue'
import { gateFromCode } from '@/lib/gates'
import type { Evidence } from '@/api/types'

const mounted: VueWrapper[] = []
function track<T extends VueWrapper>(w: T): T {
  mounted.push(w)
  return w
}
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.innerHTML = ''
})

const EV: Evidence = {
  evidenceVersionId: 9001,
  sourceType: 'law_article',
  sourceName: '약관의 규제에 관한 법률',
  identifier: '제8조',
  excerpt: '고객에게 부당하게 과중한 지연 손해금 등의 손해배상 의무를 부담시키는 약관 조항은 무효로 한다',
  sourceUrl: 'https://law.example/8',
  effectiveDate: '2024-01-01',
  changedSinceAnalysis: false,
}

describe('C1 진행 레일', () => {
  it('진행·완료·대기 상태와 aria-live polite', () => {
    const w = mount(C1Rail, {
      props: {
        label: 'REQ-142',
        steps: [
          { label: '입력·검증', state: 'done' },
          { label: '비식별화·구조화', state: 'now' },
          { label: '탐지·판정', state: 'wait' },
          { label: '결과', state: 'wait' },
        ],
        detail: [
          { label: '수신', state: 'done' },
          { label: '비식별화', state: 'running' },
          { label: '구조화', state: 'waiting' },
        ],
      },
    })
    expect(w.find('[aria-live="polite"]').exists()).toBe(true)
    expect(w.find('.step.now').attributes('aria-current')).toBe('step')
    expect(w.find('.step.done').text()).toBe('1. 입력·검증 완료')
    expect(w.find('[data-part="detail"]').text()).toContain('비식별화 진행 중')
    expect(w.html()).toMatchSnapshot()
  })
  it('차단·해제 대기·재사용 표기', () => {
    const w = mount(C1Rail, {
      props: {
        steps: [
          { label: '기록 열람', state: 'reuse' },
          { label: '근거 적합성', state: 'hold', gate: 'G11' },
          { label: '탐지·판정', state: 'block', gate: 'G5' },
        ],
      },
    })
    expect(w.find('.step.block').text()).toBe('3. 탐지·판정 · 멈춤')
    expect(w.find('.step.hold').text()).toBe('2. 근거 적합성 · 기다리는 중')
    expect(w.find('.step.reuse').text()).toBe('1. 기록 열람 · 지난 결과 사용')
    expect(w.html()).toMatchSnapshot()
  })
})

describe('C2 게이트 차단 블록', () => {
  it('role=alert, 사유·해제 주체·다음 행동, 닫기 버튼 없음, 제목으로 포커스', async () => {
    const w = track(mount(C2GateBlock, { props: { gate: gateFromCode('G3') }, attachTo: document.body }))
    await nextTick()
    expect(w.attributes('role')).toBe('alert')
    expect(w.find('.gate-id').text()).toBe('G3')
    expect(w.find('[data-part="reason"]').text()).not.toBe('')
    expect(w.find('[data-part="actor"]').text()).toContain('사용자')
    expect(w.findAll('button').map((b) => b.text())).toEqual(['파일 업로드로 전환', '텍스트 붙여넣기로 전환'])
    expect(w.text()).not.toContain('닫기')
    expect(document.activeElement).toBe(w.find('.gate-title').element)
    await w.find('[data-action="switch_to_text"]').trigger('click')
    expect(w.emitted('action')?.[0]).toEqual(['switch_to_text'])
    expect(w.html()).toMatchSnapshot()
  })
  it('접근 차단형(full) 변형', () => {
    const w = mount(C2GateBlock, { props: { gate: gateFromCode('G14'), full: true, autofocus: false } })
    expect(w.classes()).toContain('full')
    expect(w.attributes('data-variant')).toBe('full')
    expect(w.text()).toContain('접근 권한이 없습니다')
  })
  it('시스템 해제형 G4 — 행동 버튼 없이 해제 조건만', () => {
    const w = mount(C2GateBlock, { props: { gate: gateFromCode('G4', { releaseText: '시스템 - 10-01 초기화' }), autofocus: false } })
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.find('[data-part="actor"]').text()).toBe('시스템 - 10-01 초기화')
  })
})

describe('C3 사유 붙은 비활성 버튼', () => {
  it('비활성: aria-disabled + aria-describedby 로 사유 연결, 포커스 가능, 클릭 무시', async () => {
    const w = track(mount(C3ReasonButton, {
      props: { label: '분석 시작', primary: true, reason: { gate: 'G4', text: '이번 달 무료 분석 3건을 모두 사용했습니다 - 10-01 초기화' } },
      attachTo: document.body,
    }))
    const btn = w.find('button')
    expect(btn.attributes('aria-disabled')).toBe('true')
    expect(btn.attributes('disabled')).toBeUndefined()
    const id = btn.attributes('aria-describedby')!
    expect(id).toBeTruthy()
    const reason = w.find(`#${id}`)
    expect(reason.text()).not.toContain('G4') // 게이트 번호는 C2 블록에만 — 사유 글에는 내부 번호를 보이지 않는다(2026-10-01)
    expect(reason.text()).toContain('무료 분석 3건')
    expect(reason.text()).toContain('이번 달 무료 분석 3건을 모두 사용했습니다')
    expect(btn.attributes('title')).toBe('이번 달 무료 분석 3건을 모두 사용했습니다 - 10-01 초기화')
    expect(btn.classes()).not.toContain('btn-primary')
    ;(btn.element as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(btn.element)
    await btn.trigger('click')
    expect(w.emitted('click')).toBeUndefined()
    expect(w.html()).toMatchSnapshot()
  })
  it('활성: 채운 주 버튼, 클릭 전달', async () => {
    const w = mount(C3ReasonButton, { props: { label: '분석 시작', primary: true } })
    expect(w.find('button').classes()).toContain('btn-primary')
    expect(w.find('button').attributes('aria-disabled')).toBeUndefined()
    await w.find('button').trigger('click')
    expect(w.emitted('click')).toHaveLength(1)
  })
  it('처리 중: aria-busy, 클릭 무시', async () => {
    const w = mount(C3ReasonButton, { props: { label: '결과 보기', busy: true, busyLabel: '저장 중…' } })
    expect(w.find('button').attributes('aria-busy')).toBe('true')
    expect(w.find('button').text()).toBe('저장 중…')
    await w.find('button').trigger('click')
    expect(w.emitted('click')).toBeUndefined()
  })
})

describe('C4 기준일·비자문 고지 띠', () => {
  it('비자문 고지·기준일·관점(사업자)', () => {
    const w = mount(C4BasisBand, { props: { knowledgeDate: '2026-09-15', perspective: 'business' } })
    expect(w.text()).toContain('법률 자문이 아니에요')
    expect(w.text()).toContain('2026-09-15')
    expect(w.text()).toContain('보는 입장 사업자')
    expect(w.text()).not.toContain('소비자')
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.html()).toMatchSnapshot()
  })
})

describe('C5 판정 배지', () => {
  it('위험도 = 글자 + 기호(aria) + 모양 클래스, 읽기 전용', () => {
    const w = mount(C5VerdictBadge, { props: { category: 'unfair', riskType: 'excessive_penalty', riskLevel: 'high', confidence: 'medium' } })
    const risk = w.find('.risk')
    expect(risk.classes()).toContain('high')
    expect(risk.text()).toBe('위험도 높음')
    expect(risk.attributes('aria-label')).toContain('●')
    expect(w.text()).toContain('불공정 가능')
    expect(w.text()).toContain('과도한 위약금')
    expect(w.text()).toContain('확신 정도 보통')
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.html()).toMatchSnapshot()
  })
  it('근거 미확인 강등 · 전문가 검토 권장 · 분석 불가', () => {
    const a = mount(C5VerdictBadge, { props: { category: 'dispute', riskLevel: 'low', evidenceUnconfirmed: true, expertReviewRecommended: true } })
    expect(a.find('.cat').text()).toBe('분쟁 가능 · 근거를 못 찾음')
    expect(a.text()).toContain('전문가에게도 확인받아 보세요')
    expect(a.find('.risk.low').attributes('aria-label')).toContain('○')
    const b = mount(C5VerdictBadge, { props: { category: 'unanalyzable' } })
    expect(b.find('.cat').classes()).toContain('unanalyzable')
    expect(b.find('.risk').exists()).toBe(false)
    const c = mount(C5VerdictBadge, { props: { category: 'dispute', riskLevel: 'mid' } })
    expect(c.find('.risk.mid').attributes('aria-label')).toContain('◐')
  })
})

describe('C6 근거 칩 + D1 출처 드로어', () => {
  it('칩: 출처 유형 + 식별 정보, 변경됨·강조 상태, 클릭 시 open', async () => {
    const w = mount(C6EvidenceChip, { props: { evidence: { ...EV, changedSinceAnalysis: true }, lit: true } })
    expect(w.classes()).toEqual(expect.arrayContaining(['chip', 'lit', 'changed']))
    expect(w.text()).toContain('법령')
    expect(w.text()).toContain('제8조')
    await w.trigger('click')
    expect(w.emitted('open')?.[0][0]).toMatchObject({ evidenceVersionId: 9001 })
    expect(w.html()).toMatchSnapshot()
  })

  it('드로어: 열리면 제목 포커스, 6항목, Esc 로 닫고 누른 칩으로 포커스 복귀', async () => {
    const Host = defineComponent({
      setup() {
        const open = ref(false)
        const opener = ref<HTMLElement | null>(null)
        return () =>
          h('div', [
            h(C6EvidenceChip, { evidence: EV, onOpen: (_e: Evidence, el: HTMLElement) => { opener.value = el; open.value = true } }),
            h(D1SourceDrawer, { open: open.value, evidence: EV, opener: opener.value, onClose: () => (open.value = false) }),
          ])
      },
    })
    const w = track(mount(Host, { attachTo: document.body }))
    const chip = w.find('.chip')
    ;(chip.element as HTMLElement).focus()
    await chip.trigger('click')
    await nextTick()
    await nextTick()
    const drawer = w.find('[data-c="D1"]')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('role')).toBe('dialog')
    expect(document.activeElement?.id).toBe('d1-title')
    const dts = drawer.findAll('dt').map((d) => d.text())
    for (const k of ['출처 유형', '출처명', '조항 · 번호', '원문 발췌', '시행일', '출처 링크']) expect(dts).toContain(k)
    const link = drawer.find('a[target="_blank"]')
    expect(link.attributes('rel')).toContain('noopener')
    await drawer.trigger('keydown', { key: 'Escape' })
    await nextTick()
    await nextTick()
    expect(w.find('[data-c="D1"]').exists()).toBe(false)
    expect(document.activeElement).toBe(chip.element)
  })

  it('드로어: Tab 포커스 순환', async () => {
    const w = track(mount(D1SourceDrawer, { props: { open: true, evidence: EV }, attachTo: document.body }))
    await nextTick()
    const f = w.findAll('a[href],button')
    const last = f[f.length - 1].element as HTMLElement
    last.focus()
    await w.find('[data-c="D1"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(f[0].element)
  })

  it('사례 근거는 3구분을 보이고 사건 식별번호는 숨긴다', () => {
    const CASE = { ...EV, sourceType: 'ftc_case' as const, sourceName: '(주)가나의 이용 약관 시정 (FTC-2023-12-18-43165)', identifier: 'FTC-2023-12-18-43165-03-1', caseFacts: '사실', caseJudgment: '판단', caseBasis: '근거' }
    const w = mount(D1SourceDrawer, { props: { open: true, evidence: CASE } })
    const dts = w.findAll('dt').map((d) => d.text())
    expect(dts).toEqual(expect.arrayContaining(['사건', '무슨 일이 있었나', '공정위 판단', '판단한 이유', '공개일']))
    expect(w.text()).toContain('(주)가나의 이용 약관 시정')
    expect(w.text()).not.toContain('FTC-2023')
    const chip = mount(C6EvidenceChip, { props: { evidence: CASE } })
    expect(chip.text()).not.toContain('FTC-')
    const noName = mount(C6EvidenceChip, { props: { evidence: { ...CASE, sourceName: '(FTC-2023-12-18-43165)' } } })
    expect(noName.text()).toBe('공정위 사례')
  })
})

describe('C7 영역 대체 문구', () => {
  it.each([
    ['processing', '진행 중'],
    ['unavailable', '지금은 볼 수 없어요'],
    ['na', '해당 없어요'],
  ] as const)('%s → %s', (kind, label) => {
    const w = mount(C7AreaPlaceholder, { props: { kind, text: '요약 제공 불가 - 요약 모델이 응답하지 않았습니다' } })
    expect(w.find('.kind').text()).toBe(label)
    expect(w.html()).toMatchSnapshot()
  })
})

describe('C8 가림 표기', () => {
  it('〔유형〕 을 가림 표기로, 스크린리더는 "가림, 유형"', () => {
    const w = mount(C8Masked, { props: { text: '갑 〔이름〕 연락처 〔전화번호〕 로 문의' } })
    const masks = w.findAll('.mask')
    expect(masks).toHaveLength(2)
    expect(masks[1].attributes('aria-label')).toBe('가림, 전화번호')
    expect(masks[1].text()).toBe('〔전화번호〕')
    expect(w.text()).toBe('갑 〔이름〕 연락처 〔전화번호〕 로 문의')
    expect(w.html()).toMatchSnapshot()
  })
})

describe('C9 근거 변경 안내 띠', () => {
  it('변경 없으면 숨김, 있으면 유형별 개수 + 변경 내용 보기·재분석', async () => {
    expect(mount(C9ImpactBand, { props: { impact: { amend: 0, repeal: 0, newCase: 0, stdTermsRevision: 0 } } }).find('[data-c="C9"]').exists()).toBe(false)
    const w = mount(C9ImpactBand, { props: { impact: { amend: 1, repeal: 0, newCase: 2, stdTermsRevision: 0 } } })
    expect(w.text()).toContain('개정 1')
    expect(w.text()).toContain('새 사례 2')
    expect(w.text()).toContain('다시 분석')
    await w.find('[data-action="reanalyze"]').trigger('click')
    expect(w.emitted('reanalyze')).toHaveLength(1)
    const s8 = mount(C9ImpactBand, { props: { impact: { amend: 1 }, variant: 's8' } })
    expect(s8.findAll('button')).toHaveLength(0)
    expect(w.html()).toMatchSnapshot()
  })
})

describe('C11 모델 서버 상태 표시', () => {
  const at = '2026-09-30T10:42:00+09:00'
  it('ready', () => {
    const w = mount(C11ModelServerState, { props: { status: { state: 'ready', checkedAt: at, coldStart: false } } })
    expect(w.find('.status').classes()).toContain('ready')
    expect(w.text()).toContain('바로 분석할 수 있어요')
    expect(w.find('time').exists()).toBe(true)
    expect(w.html()).toMatchSnapshot()
  })
  it('ready + coldStart → 모델 대기 중(cold), 예상 추가 시간 N초', () => {
    const w = mount(C11ModelServerState, { props: { status: { state: 'ready', checkedAt: at, coldStart: true, warmupEstimateSec: 25 } } })
    expect(w.find('.status').classes()).toContain('cold')
    expect(w.text()).toContain('잠시 쉬는 중')
    expect(w.find('[data-part="note"]').text()).toContain('첫 분석만 약 25초 더 걸려요')
    expect(w.html()).toMatchSnapshot()
  })
  it('loading · unreachable · 수동 새로고침만', async () => {
    const l = mount(C11ModelServerState, { props: { status: { state: 'loading', checkedAt: at } } })
    expect(l.find('.status').classes()).toContain('loading')
    expect(l.text()).toContain('분석 준비 중')
    const u = mount(C11ModelServerState, { props: { status: { state: 'unreachable', checkedAt: at } } })
    expect(u.find('.status').classes()).toContain('down')
    expect(u.text()).toContain('연결 안 됨')
    await u.find('[data-action="refresh"]').trigger('click')
    expect(u.emitted('refresh')).toHaveLength(1)
    const k = mount(C11ModelServerState, { props: { status: { state: 'auth_mismatch', checkedAt: at, httpStatus: 401 }, admin: true } })
    expect(k.find('.status').classes()).toContain('key')
    expect(k.text()).toContain('접속 키가 맞지 않음 401')
  })
})

describe('진행 대기 안내 줄', () => {
  it('mm:ss 경과 + 콜드 스타트 안내 + 예상 범위, 시계는 aria-live off', () => {
    const w = mount(ProgressWaitLine, {
      props: { elapsedSec: 75, notice: { kind: 'cold_start', model: 'M4', message: '', estimatedSec: 20 } },
    })
    expect(w.find('[data-part="elapsed"]').text()).toBe('01:15')
    expect(w.find('[data-part="elapsed"]').attributes('aria-live')).toBe('off')
    expect(w.find('[data-part="notice"]').text()).toContain('계약 요약을 준비하고 있어요.')
    expect(w.find('[data-part="notice"]').text()).not.toMatch(/모델|메모리|입니다/) // 내부 용어 · 합니다체 없음
    expect(w.find('[data-part="notice"]').text()).toContain('약 20초')
    expect(w.find('[data-part="expected"]').text()).toContain('보통 1~3분')
    expect(w.html()).toMatchSnapshot()
  })
  it('단계 이름 조사(을/를)가 맞다', () => {
    const t = (model: string) => mount(ProgressWaitLine, { props: { elapsedSec: 1, notice: { kind: 'cold_start', model: model as 'M1', message: '서버 문구', estimatedSec: null } } }).find('[data-part="notice"]').text()
    expect(t('M1')).toContain('위험 조항 찾기를 준비하고 있어요.')
    expect(t('M3')).toContain('위험 판단을 준비하고 있어요.')
    expect(t('M4')).toContain('계약 요약을 준비하고 있어요.')
    expect(t('M9')).toContain('분석을 준비하고 있어요.')
  })
  it('queue 안내는 화면 문구(서버 문구의 내부 용어를 드러내지 않음)', () => {
    const w = mount(ProgressWaitLine, {
      props: { elapsedSec: 5, notice: { kind: 'queue', model: 'M3', message: '공유 모델 서버에서 앞선 요청을 기다리는 중…', estimatedSec: null } },
    })
    expect(w.find('[data-part="notice"]').text()).toContain('앞선 분석이 끝나기를 기다리고 있어요')
    expect(w.find('[data-part="notice"]').text()).not.toContain('공유 모델 서버')
  })
})

describe('확인 대화상자', () => {
  it('취소 확인 문구(FR-035) · 열리면 취소 버튼 포커스 · Esc 취소 · 닫히면 포커스 복귀', async () => {
    const Host = defineComponent({
      setup() {
        const open = ref(false)
        return () =>
          h('div', [
            h('button', { id: 'opener', onClick: () => (open.value = true) }, '분석 취소'),
            h(CancelAnalysisDialog, { open: open.value, onCancel: () => (open.value = false), onConfirm: () => (open.value = false) }),
          ])
      },
    })
    const w = track(mount(Host, { attachTo: document.body }))
    const opener = w.find('#opener')
    ;(opener.element as HTMLElement).focus()
    await opener.trigger('click')
    await nextTick()
    await nextTick()
    expect(w.find('[data-part="cancel-notice"]').text()).toBe('지금 하던 분석을 멈춰요. 다시 하려면 새 분석을 시작해 주세요.')
    expect(document.activeElement?.getAttribute('data-action')).toBe('cancel')
    await w.find('.dialog-scrim').trigger('keydown', { key: 'Escape' })
    await nextTick()
    await nextTick()
    expect(w.find('.dialog').exists()).toBe(false)
    expect(document.activeElement).toBe(opener.element)
  })
  it('삭제 확인은 피드백 익명 보존을 안내한다(T111)', () => {
    const w = mount(DeleteConfirm, { props: { open: true } })
    expect(w.find('[data-part="delete-notice"]').text()).toBe(
      '올린 문서와 분석 결과가 완전히 지워지고, 되돌릴 수 없어요. 이 결과에 남긴 의견은 누가 썼는지 알 수 없게 바꿔서만 남겨 둬요.',
    )
  })
  it('ConfirmDialog 확인 이벤트', async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: 't' } })
    await w.find('[data-action="confirm"]').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
  })
})
