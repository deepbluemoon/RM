<script setup lang="ts">
// S9 API 활용 (SD_02 §13) — T141. 2026-09-30: 사용자도 연다(기능 목록 · 처음 써 보기 · API 키 · 이용 규칙).
// 서버 상태 · 운영 매뉴얼 · 문서·점검 결과와 전체 키 관리는 운영자(modelApi.manage)만. 탭은 주소 ?tab= 과 맞춘다(메뉴 창에서 바로 연다).
// API 는 발급받은 키로 부른다 — 이 화면의 "API 키" 탭에서 발급 · 폐기. 키 원문은 발급 순간 한 번만 보인다(서버는 해시만 저장).
// 자동 새로고침 없음 — 열 때 1회 + 수동 새로고침(백엔드 60초 캐시, 공유 모델 서버 폴링 금지).
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api/endpoints'
import { ApiError, GateApiError } from '@/api/client'
import { toGateView, type GateView } from '@/lib/gates'
import { MODEL_LOAD_STATE, MODEL_NAME } from '@/lib/labels'
import { useSessionStore } from '@/stores/session'
import C2GateBlock from '@/components/common/C2GateBlock.vue'
import C11ModelServerState from '@/components/common/C11ModelServerState.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import type { AdminApiKey, ApiKey, ModelApiStatus, ModelDoc, ModelDocName, ServiceTestResult } from '@/api/types'

const session = useSessionStore()
const canManage = computed(() => session.can('modelApi.manage'))
type Tab = 'endpoints' | 'quickstart' | 'keys' | 'guidelines' | 'manual' | 'status' | 'docs'
const TABS = computed(() => session.apiMenu.map((a) => [a.tab as Tab, a.label] as [Tab, string]))
const isTab = (v: unknown): v is Tab => TABS.value.some((t) => t[0] === v)
const router = useRouter()
const route = useRoute()
const tab = ref<Tab>(isTab(route.query.tab) ? route.query.tab : 'endpoints')
watch(() => route.query.tab, (q) => { if (isTab(q)) tab.value = q })
watch(tab, (t) => { if (route.query.tab !== t) void router.replace({ query: { ...route.query, tab: t } }) })
const status = ref<ModelApiStatus | null>(null)
const loading = ref(false)
const failed = ref(false)
const pageGate = ref<GateView | null>(null)

async function load() {
  loading.value = true
  try {
    status.value = canManage.value ? await api.modelApiStatus() : ((await api.modelServerStatus()) as unknown as ModelApiStatus)
    failed.value = false
  } catch (e) {
    if (e instanceof GateApiError) pageGate.value = toGateView(e.body)
    else failed.value = true
  } finally {
    loading.value = false
  }
}
// 서버 상태 한 줄은 어느 탭에서도 보인다 — 열 때 1회(백엔드 60초 캐시, 폴링 없음)
onMounted(() => {
  void load()
  if (tab.value === 'docs') void openDoc(docName.value)
  if (tab.value === 'keys') void loadKeys()
})
watch(tab, (t) => {
  if (t === 'docs' && !doc.value) openDoc(docName.value)
  if (t === 'keys' && !keysLoaded.value) void loadKeys()
})

// API 키 — 내 키 목록 · 발급 · 폐기. 운영자는 전체 키도 본다
const myKeys = ref<ApiKey[]>([])
const allKeys = ref<AdminApiKey[]>([])
const keysLoaded = ref(false)
const keysFailed = ref(false)
const newKeyName = ref('')
const issuing = ref(false)
const issueError = ref<string | null>(null)
const issued = ref<{ name: string; key: string } | null>(null)
const revokeTarget = ref<{ keyId: number; name: string; admin: boolean } | null>(null)
const revoking = ref(false)
const revokeFailed = ref(false)
async function loadKeys() {
  keysFailed.value = false
  try {
    myKeys.value = (await api.apiKeys()).items
    if (canManage.value) allKeys.value = (await api.adminApiKeys()).items
    keysLoaded.value = true
  } catch {
    keysFailed.value = true
  }
}
async function issueKey() {
  issuing.value = true
  issueError.value = null
  try {
    const r = await api.issueApiKey(newKeyName.value.trim())
    issued.value = { name: r.name, key: r.key }
    newKeyName.value = ''
    await loadKeys()
  } catch (e) {
    issueError.value = e instanceof ApiError && e.problem?.message ? e.problem.message : '키를 만들지 못했어요. 잠시 뒤 다시 해 주세요.'
  } finally {
    issuing.value = false
  }
}
async function doRevoke() {
  const t = revokeTarget.value
  if (!t) return
  revoking.value = true
  revokeFailed.value = false
  try {
    await (t.admin ? api.adminRevokeApiKey(t.keyId) : api.revokeApiKey(t.keyId))
    revokeTarget.value = null
    await loadKeys()
  } catch {
    revokeFailed.value = true
  } finally {
    revoking.value = false
  }
}
const activeKeys = computed(() => myKeys.value.filter((k) => !k.revokedAt))
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR') : '—')
const STATUS_LINE: Record<string, string> = {
  ready: '정상 — 지금 부를 수 있어요',
  loading: '준비 중 — 잠시 뒤 다시 불러 주세요',
  unreachable: '멈춤 — 지금은 부를 수 없어요',
  auth_mismatch: '서버 설정 확인 필요 — 운영자에게 알려 주세요',
  not_implemented: '확인할 수 없음',
}
const statusLine = computed(() => {
  if (loading.value && !status.value) return { cls: 'loading', text: '확인 중' }
  if (failed.value || !status.value) return { cls: 'down', text: '확인할 수 없음' }
  const st = status.value.state
  return { cls: st === 'ready' ? 'ready' : st === 'loading' ? 'loading' : st === 'auth_mismatch' ? 'key' : 'down', text: STATUS_LINE[st] ?? st }
})

// 문서·점검 결과 — model-server/docs, reports (백엔드가 정해진 파일만 읽어 준다)
const DOCS: Array<[ModelDocName, string]> = [['test-result', '서비스 점검 결과'], ['guideline', '운영 가이드라인'], ['manual', '사용자 매뉴얼'], ['model-test', '모델 테스트 보고서']]
const docName = ref<ModelDocName>('test-result')
const doc = ref<ModelDoc | null>(null)
const docFailed = ref(false)
async function openDoc(name: ModelDocName) {
  docName.value = name
  docFailed.value = false
  try {
    doc.value = await api.modelApiDoc(name)
  } catch {
    doc.value = null
    docFailed.value = true
  }
}
const testResult = computed(() => (doc.value?.format === 'json' ? (doc.value.content as ServiceTestResult) : null))
const fmtTime = (iso: string) => new Date(iso).toLocaleString('ko-KR')

const models = computed(() => {
  const list = status.value?.models ?? []
  return (['M1', 'M2', 'M3', 'M4'] as const).map((id) => {
    const m = list.find((x) => x.id === id)
    return { id, name: m?.name ?? MODEL_NAME[id], loadState: m?.loadState ?? 'missing', modelVersion: m?.modelVersion ?? '', trainedDataDate: m?.trainedDataDate ?? null }
  })
})
const STATE_CLASS: Record<string, string> = { ready: 'ready', loading: 'loading', cold: 'cold', missing: 'missing', error: 'down' }
const missing = computed(() => models.value.filter((m) => m.loadState === 'missing'))
const missingLlm = computed(() => missing.value.filter((m) => m.id === 'M3' || m.id === 'M4'))
const missingCls = computed(() => missing.value.filter((m) => m.id === 'M1' || m.id === 'M2'))
const cold = computed(() => models.value.filter((m) => m.loadState === 'cold'))
const gb = (mb?: number) => (mb == null ? '' : (mb / 1024).toFixed(1))

/** 외부 프로그램이 부를 주소 — 이 웹 서비스가 발급 키를 확인하고 모델 서버로 넘긴다 */
const BASE_URL = `${window.location.origin}/api/model`
const ENDPOINTS = [
  { m: 'GET', p: '/health', d: '서버가 지금 쓸 수 있는 상태인지 알려 줘요', model: '—', in: '없음', out: '상태(ready · cold · missing) · 기다리는 요청 수 · 준비에 걸릴 예상 초', t: '바로' },
  { m: 'GET', p: '/v1/models', d: '쓰고 있는 모델 목록 · 버전 · 학습 기준일을 알려 줘요', model: '전체', in: '없음', out: '모델 이름 · 버전 · 학습 기준일', t: '바로' },
  { m: 'POST', p: '/v1/detect/loophole', d: '조항 목록을 보내면 회피형(법을 피해 가는 꼼수) 가능성을 점수로 알려 줘요', model: '회피형 탐지', in: 'contract_type(계약 유형) · clauses[]: clause_id · text', out: '조항별 표시 · 유형 · 점수(0~1)', t: '조항당 0.1초 안팎' },
  { m: 'POST', p: '/v1/detect/illegal', d: '조항 목록을 보내면 법 위반 가능성과 관련 법령 후보를 알려 줘요', model: '위법형 탐지', in: 'contract_type · clauses[] (위와 같음)', out: '조항별 표시 · 관련 법령 · 점수', t: '조항당 0.1초 안팎' },
  { m: 'POST', p: '/v1/jobs', d: '긴 문서를 한 번에 맡기고 나중에 결과를 받아요(회피형 · 위법형 함께)', model: '회피형 · 위법형 탐지', in: 'clauses[] + contract_type(계약 유형)', out: '접수 번호(job_id)', t: '바로 접수' },
  { m: 'GET', p: '/v1/jobs/{job_id}', d: '맡긴 작업이 얼마나 됐는지 보고 결과를 받아요(1시간 보관)', model: '회피형 · 위법형 탐지', in: '주소의 job_id', out: '진행 상태 · 진행률 · 결과', t: '100조항 약 4~11초' },
  { m: 'POST', p: '/v1/judge', d: '조항 · 점수를 보내면 서버가 근거를 찾아 최종 판단과 설명을 돌려줘요', model: '최종 판단', in: 'clause · contract_type · perspective(consumer · business) · knowledge_date · scores · evidence(선택, 10개까지 — 빼면 서버가 찾아요)', out: '위험 분류 · 위험도 · 설명 · 쓴 근거', t: '2~5초(처음 부를 때 +10~30초)' },
  { m: 'POST', p: '/v1/summarize', d: '조항 목록을 보내면 계약 요약과 계약 유형 후보를 돌려줘요', model: '계약 요약', in: 'clauses[]', out: '요약 · 계약 유형 후보', t: '약 2초(처음 부를 때 +10~30초)' },
]
const ERRORS = [
  { c: 400, d: '보낸 값이 잘못됐어요. 꼭 넣어야 할 값이 빠졌거나 형식이 달라요', fix: '기능 목록의 "넣을 값"을 확인해 주세요. perspective 는 consumer · business, 점수는 0~1이에요' },
  { c: 401, d: 'API 키가 없거나 틀렸어요. 폐기된 키일 수도 있어요', fix: 'Authorization: Bearer <발급받은 키> 머리글을 넣어 주세요. 키는 "API 키" 탭에서 만들 수 있어요' },
  { c: 404, d: '없는 주소이거나, 1시간이 지나 지워진 작업 번호예요', fix: '주소를 확인하거나, POST /v1/jobs 로 다시 맡겨 주세요' },
  { c: 413, d: '너무 커요. 한 번에 조항 2,000개, 본문 3MB까지예요', fix: '조항을 나눠서 여러 번 보내 주세요' },
  { c: 429, d: '너무 자주 불렀어요. 1분에 60번까지예요', fix: '잠시 쉬었다가 다시 불러 주세요' },
  { c: 503, d: '모델을 준비하는 중이거나 서버가 멈췄어요', fix: 'GET /health 로 상태를 보고, 안내된 시간만큼 기다린 뒤 다시 불러 주세요' },
  { c: 504, d: '시간이 너무 걸렸어요. 준비와 대기를 합쳐 300초를 넘었어요', fix: '모델 서버는 한 번에 1건씩만 처리해요. 잠시 뒤 다시 불러 주세요' },
]

// 처음 써 보기 — 키 자리는 비워 둔다(발급받은 키를 넣어 실행)
type Lang = 'curl' | 'python' | 'js'
const lang = ref<Lang>('curl')
const SAMPLE_BODY = `{"contract_type":"subscription","clauses":[{"clause_id":"c1","text":"구매한 이용권은 어떠한 경우에도 환불되지 않습니다."}]}`
const SAMPLES: Record<Lang, string> = {
  curl: `# 1) 서버 상태 확인
curl -s -H "Authorization: Bearer <발급받은 API 키>" ${BASE_URL}/health

# 2) 회피형 탐지
curl -s -X POST ${BASE_URL}/v1/detect/loophole \\
  -H "Authorization: Bearer <발급받은 API 키>" \\
  -H "Content-Type: application/json" \\
  -d '${SAMPLE_BODY}'`,
  python: `import httpx

BASE = "${BASE_URL}"
H = {"Authorization": "Bearer <발급받은 API 키>"}

print(httpx.get(f"{BASE}/health", headers=H).json())
r = httpx.post(f"{BASE}/v1/detect/loophole", headers=H, timeout=60, json={
    "contract_type": "subscription",
    "clauses": [{"clause_id": "c1", "text": "구매한 이용권은 어떠한 경우에도 환불되지 않습니다."}],
})
r.raise_for_status()
print(r.json())`,
  js: `const BASE = '${BASE_URL}'
const H = { Authorization: 'Bearer <발급받은 API 키>', 'Content-Type': 'application/json' }

const health = await fetch(\`\${BASE}/health\`, { headers: H }).then((r) => r.json())
const res = await fetch(\`\${BASE}/v1/detect/loophole\`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ contract_type: 'subscription', clauses: [{ clause_id: 'c1', text: '구매한 이용권은 어떠한 경우에도 환불되지 않습니다.' }] }),
})
if (!res.ok) throw new Error(\`\${res.status}\`)
console.log(health, await res.json())`,
}
const copied = ref<string | null>(null)
async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = `${what}을(를) 복사했어요.`
  } catch {
    copied.value = '복사하지 못했어요. 직접 골라 복사해 주세요.'
  }
  setTimeout(() => (copied.value = null), 2500)
}
const judgeExample = `POST ${BASE_URL}/v1/judge
Authorization: Bearer <발급받은 API 키>
{
  "clause": "구매한 이용권은 어떠한 경우에도 환불되지 않습니다.",
  "contract_type": "subscription",
  "perspective": "business",
  "knowledge_date": "2026-09-29",
  "scores": { "loophole": 0.96, "illegal": 0.79 }
}
→ 200 { "risk_class": "dispute", "risk_type": "refund_cancel_limit", "risk_level": "mid", "confidence": "medium",
        "explanation": [{ "claim": "…청약철회 권리를 제한하고 있어 …", "evidence_ids": ["1203"] }],
        "model_version": "ollama:qwen3:4b-instruct-2507-q4_K_M", "knowledge_date": "2026-09-29",
        "evidence_source": "server_search", "search_mode": "hybrid",
        "evidence": [{ "id": "1203", "source_type": "law_article", "title": "전자상거래 등에서의 소비자보호에 관한 법률 제17조",
                       "text": "… 7일 이내에 … 청약철회등을 할 수 있다.", "source_url": "…", "cited": true }, …] }
// evidence 를 빼면 서버가 근거를 찾아 넣고 응답 evidence 로 알려 줘요. 직접 보내면(10개까지) 그것만 써요`
</script>

<template>
  <div class="page wide">
    <div v-if="pageGate" class="section tight"><C2GateBlock :gate="pageGate" full @action="router.push('/')" /></div>
    <template v-else>
      <div class="api-hero">
        <div class="stack sm">
          <h1 class="t-display-xl">API 활용</h1>
        </div>
        <div class="stack sm">
          <p class="lede">내 프로그램에서 계약 위험 탐지 기능을 바로 불러 쓸 수 있어요. "API 키" 탭에서 키를 만들어 요청에 넣기만 하면 돼요. 보내는 글 속 개인정보는 서버가 한 번 더 가려요.</p>
          <div class="row">
            <a href="/docs" target="_blank" rel="noopener" class="btn btn-secondary" data-part="swagger-link">Swagger (/docs) 열기</a>
            <a :href="api.modelApiOpenapiUrl()" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" data-part="openapi-link">OpenAPI JSON</a>
          </div>
        </div>
      </div>

      <div class="api-status section tight" role="status" data-part="status-line">
        <span :class="['status', statusLine.cls]"><i aria-hidden="true" /><span>서버 상태: <strong>{{ statusLine.text }}</strong></span></span>
        <button type="button" class="btn btn-text" :aria-busy="loading ? 'true' : undefined" @click="load">다시 확인</button>
        <span class="base">부를 주소 <code>{{ BASE_URL }}</code></span>
      </div>

      <div class="tabs underline section tight" role="tablist" aria-label="API 활용">
        <button v-for="t in TABS" :key="t[0]" type="button" role="tab" class="tab" :aria-selected="tab === t[0] ? 'true' : 'false'" :data-tab="t[0]" @click="tab = t[0]">{{ t[1] }}</button>
      </div>
      <p v-if="copied" class="t-body-sm" role="status">{{ copied }}</p>

      <!-- 엔드포인트 목록 -->
      <section v-if="tab === 'endpoints'" role="tabpanel" class="stack" data-panel="endpoints">
        <div class="rules" data-part="rules">
          <h2>꼭 지켜 주세요</h2>
          <ul>
            <li>모든 요청에 <code>Authorization: Bearer &lt;발급받은 API 키&gt;</code> 머리글을 넣어요. 키는 "API 키" 탭에서 발급하고, 남에게 보여 주거나 코드 · 문서에 그대로 적지 않아요.</li>
            <li>이름 · 전화번호 같은 개인정보는 빼고 보내 주세요. 남아 있으면 서버가 한 번 더 가린 뒤 처리하고, 보낸 글은 저장하지 않아요.</li>
            <li>모델 서버는 한 번에 1건씩 처리해요. 5분 동안 쓰지 않으면 모델이 쉬러 가서 다음 첫 요청은 10~30초 더 걸려요.</li>
            <li>한 번에 조항 2,000개 · 본문 3MB까지, 1분에 60번까지 부를 수 있어요.</li>
            <li>결과 설명은 법률 자문이 아니라 위험할 수 있다는 안내예요.</li>
          </ul>
        </div>
        <div>
          <article v-for="e in ENDPOINTS" :key="e.m + e.p" class="ep" :data-ep="e.p">
            <span :class="['method', e.m === 'POST' ? 'post' : '']">{{ e.m }}</span>
            <div>
              <p class="path">{{ e.p }}</p>
              <p class="desc">{{ e.d }}</p>
              <dl>
                <dt>쓰는 모델</dt><dd>{{ e.model }}</dd>
                <dt>넣을 값</dt><dd>{{ e.in }}</dd>
                <dt>받는 값</dt><dd>{{ e.out }}</dd>
                <dt>걸리는 시간</dt><dd>{{ e.t }}</dd>
              </dl>
            </div>
          </article>
          <article class="ep" data-ep="/docs">
            <span class="method">GET</span>
            <div>
              <p class="path">/docs</p>
              <p class="desc">Swagger 화면에서 바로 불러 보세요 — Authorize 에 발급받은 키를 넣고 Try it out 을 누르면 돼요</p>
            </div>
          </article>
        </div>
        <h2 class="section-title mt-xl">최종 판단 요청 · 응답 예</h2>
        <div class="code-card">
          <div class="code-head"><span class="t-caption-sm">POST /v1/judge</span><button type="button" class="copy" @click="copy(judgeExample, '예시')">복사</button></div>
          <pre>{{ judgeExample }}</pre>
        </div>
        <h2 class="section-title mt-xl">오류가 날 때</h2>
        <p class="t-body-sm charcoal m-0">문의할 때는 응답 머리글의 <code>x-request-id</code> 값을 함께 알려 주세요.</p>
        <div class="tablewrap">
          <table class="spec" data-part="errors"><thead><tr><th>번호</th><th>뜻</th><th>고치는 방법</th></tr></thead><tbody><tr v-for="e in ERRORS" :key="e.c"><td class="mono">{{ e.c }}</td><td>{{ e.d }}</td><td>{{ e.fix }}</td></tr></tbody></table>
        </div>
      </section>

      <!-- 첫 요청 따라 하기 -->
      <section v-if="tab === 'quickstart'" role="tabpanel" class="stack" data-panel="quickstart">
        <ol class="steps">
          <li><div><h3>키 발급</h3><p>"API 키" 탭에서 키를 발급받아요. 키는 그때 한 번만 보이니 바로 복사해 두세요.</p></div></li>
          <li><div><h3>서버 상태 확인</h3><p><code>GET /health</code> 가 <code>ready</code> 인지 봐요. <code>cold</code> 면 첫 요청이 10~30초 더 걸려요.</p></div></li>
          <li><div><h3>첫 요청 보내기</h3><p>아래 예시의 <code>&lt;발급받은 API 키&gt;</code> 자리에 키를 넣어 실행해 보세요.</p></div></li>
          <li><div><h3>결과 읽기</h3><p><code>score</code> 는 0~1 사이 위험 점수예요(1에 가까울수록 위험). 최종 판단과 설명은 <code>POST /v1/judge</code> 로 받아요.</p></div></li>
        </ol>
        <div class="code-card" data-part="quickstart-code">
          <div class="code-head">
            <div class="langs" role="tablist" aria-label="언어">
              <button v-for="l in (['curl', 'python', 'js'] as const)" :key="l" type="button" role="tab" class="lang" :aria-selected="lang === l ? 'true' : 'false'" @click="lang = l">{{ l === 'js' ? 'JavaScript' : l === 'python' ? 'Python' : 'curl' }}</button>
            </div>
            <button type="button" class="copy" data-action="copy-sample" @click="copy(SAMPLES[lang], '예시')">복사</button>
          </div>
          <pre>{{ SAMPLES[lang] }}</pre>
        </div>
        <p class="t-caption-sm muted m-0">contract_type 은 ecommerce(전자상거래) · subscription(구독) · installment(할부) · door_to_door(방문판매) · general_consumer(일반 소비자 거래) 중 하나예요. 키 자리는 비워 두었어요. 발급받은 키를 넣어 실행해 보세요. Swagger(/docs)에서는 Authorize 에 키를 넣고 Try it out 으로 바로 불러 볼 수 있어요.</p>
      </section>

      <!-- API 키 -->
      <section v-if="tab === 'keys'" role="tabpanel" class="stack" data-panel="keys">
        <div class="card stack sm">
          <h3 class="m-0">새 키 발급</h3>
          <p class="t-body-sm charcoal m-0">알아보기 쉬운 이름(예: 사내 검토 도구)을 붙여 주세요. 쓰고 있는 키는 5개까지 둘 수 있어요.</p>
          <form class="row" @submit.prevent="issueKey">
            <label for="key-name" class="visually-hidden">키 이름</label>
            <input id="key-name" v-model="newKeyName" class="text-input" maxlength="40" placeholder="키 이름" data-part="key-name" />
            <button type="submit" class="btn btn-primary" :disabled="issuing || activeKeys.length >= 5" :aria-busy="issuing ? 'true' : undefined" data-action="issue-key">{{ issuing ? '만들고 있어요…' : '키 발급' }}</button>
          </form>
          <p v-if="issueError" role="alert" class="t-body-sm m-0">{{ issueError }}</p>
        </div>

        <div v-if="issued" class="card strong stack sm" role="status" data-part="issued-key">
          <h3 class="m-0">"{{ issued.name }}" 키를 만들었어요</h3>
          <p class="t-body-sm m-0"><strong>지금 한 번만 보여요.</strong> 창을 닫으면 다시 볼 수 없으니 바로 복사해 안전한 곳에 두세요.</p>
          <div class="code-card">
            <div class="code-head"><span class="t-caption-sm">API 키</span><button type="button" class="copy" data-action="copy-key" @click="copy(issued.key, 'API 키')">복사</button></div>
            <pre class="key-text">{{ issued.key }}</pre>
          </div>
          <button type="button" class="btn btn-secondary self-start" @click="issued = null">복사했어요, 닫기</button>
        </div>

        <h2 class="section-title mt-lg">내 키</h2>
        <p v-if="keysFailed" class="t-body-sm">키 목록을 불러오지 못했어요. <button type="button" class="btn btn-text" @click="loadKeys">다시 시도</button></p>
        <p v-else-if="keysLoaded && !myKeys.length" class="t-body-sm muted">아직 발급한 키가 없어요.</p>
        <div v-else-if="myKeys.length" class="tablewrap">
          <table class="spec" data-part="my-keys">
            <thead><tr><th>이름</th><th>키 앞자리</th><th>만든 때</th><th>마지막 사용</th><th>상태</th><th><span class="visually-hidden">폐기</span></th></tr></thead>
            <tbody>
              <tr v-for="k in myKeys" :key="k.keyId" :data-key="k.keyId">
                <td>{{ k.name }}</td>
                <td class="mono">{{ k.keyPrefix }}…</td>
                <td>{{ fmtDate(k.createdAt) }}</td>
                <td>{{ fmtDate(k.lastUsedAt) }}</td>
                <td><span :class="['status', k.revokedAt ? 'down' : 'ready']"><i aria-hidden="true" />{{ k.revokedAt ? '폐기됨' : '사용 중' }}</span></td>
                <td><button v-if="!k.revokedAt" type="button" class="btn btn-text" data-action="revoke-key" @click="revokeTarget = { keyId: k.keyId, name: k.name, admin: false }">폐기</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="canManage">
          <h2 class="section-title mt-lg">모든 이용자의 키 <span class="t-caption-sm muted">운영자</span></h2>
          <p class="t-body-sm charcoal m-0">누가 어떤 키를 쓰는지 보고, 잘못 쓰이는 키를 폐기할 수 있어요. 폐기한 키로 온 요청은 바로 거절됩니다.</p>
          <p v-if="keysLoaded && !allKeys.length" class="t-body-sm muted">발급된 키가 없어요.</p>
          <div v-else-if="allKeys.length" class="tablewrap">
            <table class="spec" data-part="all-keys">
              <thead><tr><th>이용자</th><th>이름</th><th>키 앞자리</th><th>만든 때</th><th>마지막 사용</th><th>상태</th><th><span class="visually-hidden">폐기</span></th></tr></thead>
              <tbody>
                <tr v-for="k in allKeys" :key="k.keyId">
                  <td>{{ k.ownerName ?? `이용자 ${k.userId}` }}<span v-if="k.ownerLoginId" class="muted"> ({{ k.ownerLoginId }})</span></td>
                  <td>{{ k.name }}</td>
                  <td class="mono">{{ k.keyPrefix }}…</td>
                  <td>{{ fmtDate(k.createdAt) }}</td>
                  <td>{{ fmtDate(k.lastUsedAt) }}</td>
                  <td><span :class="['status', k.revokedAt ? 'down' : 'ready']"><i aria-hidden="true" />{{ k.revokedAt ? '폐기됨' : '사용 중' }}</span></td>
                  <td><button v-if="!k.revokedAt" type="button" class="btn btn-text" @click="revokeTarget = { keyId: k.keyId, name: k.name, admin: true }">폐기</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <ConfirmDialog
          :open="!!revokeTarget"
          title="키 폐기"
          :message="`'${revokeTarget?.name ?? ''}' 키를 폐기할까요? 이 키로 오는 요청은 바로 거절되고 되돌릴 수 없어요.`"
          confirm-label="폐기"
          :busy="revoking"
          @confirm="doRevoke"
          @cancel="revokeTarget = null"
        />
        <p v-if="revokeFailed" role="alert" class="t-body-sm">폐기하지 못했어요. 다시 시도해 주세요.</p>
      </section>

      <!-- 서버 상태 -->
      <section v-if="tab === 'status'" role="tabpanel" class="stack" data-panel="status">
        <C11ModelServerState :status="status" :loading="loading" :failed="failed" admin @refresh="load" />
        <p v-if="status?.state === 'loading'" class="t-body-sm charcoal">지금은 사용자 화면에서 분석 일시 불가(G5) 상태입니다.</p>

        <div class="tablewrap">
          <table class="spec" data-part="models">
            <thead><tr><th>모델</th><th>상태</th><th>모델 버전</th><th>학습 기준일</th></tr></thead>
            <tbody>
              <tr v-for="m in models" :key="m.id" :data-model="m.id" :data-load="m.loadState">
                <td>{{ m.id }} {{ m.name }}</td>
                <td><span :class="['status', STATE_CLASS[m.loadState] ?? 'down']"><i aria-hidden="true" />{{ MODEL_LOAD_STATE[m.loadState] ?? m.loadState }}</span></td>
                <td class="mono">{{ m.modelVersion || '—' }}</td>
                <td>{{ m.trainedDataDate ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="status?.gpuMemory" class="t-body-sm charcoal">통합 메모리 {{ gb(status.gpuMemory.usedMb) }} / {{ gb(status.gpuMemory.totalMb) }} GB</p>
        <p class="t-body-sm charcoal">API 키: 환경변수로 관리합니다. 화면에 표시하지 않습니다.</p>

        <div v-if="cold.length" class="card" data-part="cold-note">
          <h3>대기(첫 요청 시 적재) 모델 {{ cold.map((m) => m.id).join(' · ') }}</h3>
          <p class="t-body-sm charcoal m-0">
            공유 Ollama 는 5분 동안 쓰지 않은 모델을 메모리에서 내립니다. 다음 호출에는 적재 시간 약 10~30초(bf16 4B 는 더 걸릴 수 있음)가 더해지며,
            공유 서버는 한 번에 1건만 처리하므로 앞선 요청이 있으면 그만큼 기다립니다. 분석은 가능하며(G5 아님), 사용자 진행 화면에는 "분석을 준비하고 있어요…" 안내와 경과 시간이 표시됩니다.
            게이트웨이는 요약·탐지 중에 다음 단계 모델을 미리 예열합니다.
          </p>
        </div>

        <div v-if="missing.length" class="stack" data-part="provision">
          <div class="card strong">
            <h3>미설치 모델 {{ missing.map((m) => m.id).join(' · ') }} — 배포 전 수동 준비(1회)</h3>
            <p class="t-body-sm charcoal m-0">
              서비스는 실행 중에 모델을 내려받거나 만들지 않습니다(pull·create·rm 호출 없음). 미설치 모델은 /health 에서 missing 으로 보고되고 사용자 화면은 G5 로 막힙니다.
              운영자가 모델 서버 머신에서 아래 절차를 한 번 실행한 뒤 게이트웨이를 재시작하고 이 화면에서 새로고침하세요.
            </p>
          </div>
          <div class="tablewrap">
            <table class="spec">
              <thead><tr><th>단계</th><th>명령</th><th>예상 소요</th></tr></thead>
              <tbody>
                <tr><td>1 환경 준비</td><td><code>uv sync --frozen --extra classifiers</code></td><td>약 1분</td></tr>
                <tr><td>2 공식 원본 다운로드</td><td><code>uv run python scripts/fetch_models.py</code></td><td>수 분~수십 분(M3 약 8GB · M4 약 3.4GB, 회선 속도에 따라)</td></tr>
                <tr><td>3 bf16 GGUF 변환</td><td><code>uv run python scripts/convert_bf16.py</code></td><td>수 분(형식 변환이며 양자화 아님)</td></tr>
                <tr><td>4 공유 Ollama 에 등록</td><td><code>./scripts/provision_models.sh</code></td><td>약 1~3분</td></tr>
                <tr><td>5 게이트웨이 재시작</td><td><code>./scripts/install_launchd.sh restart</code></td><td>약 10초 + 첫 호출 적재 10~30초</td></tr>
              </tbody>
            </table>
          </div>
          <div class="terminal-card" aria-label="모델 준비 명령">
            <div class="lights" aria-hidden="true"><i /><i /><i /></div>
            <pre><span class="c"># 배포 전 수동 1회 — model-serving.md §0.2</span>
<span class="p">$</span> cd model-server
<span class="p">$</span> uv sync --frozen --extra classifiers      <span class="c"># 가상환경 — extra 빠지면 torch 가 지워져 M1·M2 가 휴리스틱으로 바뀜</span>
<span class="p">$</span> uv run python scripts/fetch_models.py     <span class="c"># 공식 원본(고정 revision) — 수 분~수십 분</span>
<span class="p">$</span> uv run python scripts/convert_bf16.py     <span class="c"># bf16 GGUF 변환 — 수 분</span>
<span class="p">$</span> ./scripts/provision_models.sh             <span class="c"># ollama list 중복 확인 → 10GB 한도 확인 → ollama create pioneer2-crd-m3:v1 / m4:v1 — 약 1~3분</span>
<span class="p">$</span> ./scripts/install_launchd.sh restart      <span class="c"># launchd kr.crd.model-server 재기동 — 약 10초</span></pre>
          </div>
          <p v-if="missingCls.length" class="t-body-sm charcoal">
            {{ missingCls.map((m) => m.id).join('·') }}(CPU 분류기)는 팀 파인튜닝 체크포인트와 model_card.json 을 MODEL_ROOT 아래
            (loophole-klue-roberta-base/, illegal-klue-roberta-base/)에 두고 게이트웨이를 재시작하면 적재됩니다.
          </p>
          <p v-if="missingLlm.length" class="t-caption-sm muted">등록 스크립트는 이미 있는 모델을 다시 만들지 않습니다. 모델 교체 시에는 버전 문자열이 바뀌어 판정 캐시가 자동으로 분리됩니다.</p>
        </div>

        <div v-if="status?.modelChanged" class="change-band" data-part="model-changed">
          <p><strong>모델 교체 감지</strong> - M3 가 {{ status.modelChanged.recentResultM3 }} 에서 {{ status.modelChanged.currentM3 }} 로 바뀌었습니다. 탐지 품질 평가를 권장합니다</p>
          <RouterLink to="/admin/eval" class="btn btn-secondary">탐지 품질 평가로 이동</RouterLink>
        </div>
        <button type="button" class="btn btn-secondary self-start" @click="tab = 'manual'">장애 대응 체크리스트 열기</button>
      </section>

      <!-- 이용 규칙 -->
      <section v-if="tab === 'guidelines'" role="tabpanel">
        <div class="faq-row"><h4>개인정보는 빼고 보내요</h4><p>이름 · 주민등록번호 · 전화번호 같은 개인정보는 가리고 보내 주세요. 남아 있으면 서버가 한 번 더 가린 뒤 처리하고, 보낸 글은 저장하지 않아요.</p></div>
        <div class="faq-row"><h4>결과는 법률 자문이 아니에요</h4><p>설명은 "위법이다"처럼 단정하지 않아요. 위험할 수 있다는 안내로 써 주시고, 중요한 결정은 전문가와 상의해 주세요.</p></div>
        <div class="faq-row"><h4>얼마나 자주 부를 수 있나요</h4><p>1분에 60번, 한 번에 조항 2,000개 · 본문 3MB까지예요. 모델 서버는 한 번에 1건씩 처리하므로 동시에 여러 건을 보내면 순서대로 기다려요.</p></div>
        <div class="faq-row"><h4>기다리는 시간 · 다시 시도</h4><p>최종 판단 · 요약은 준비 · 대기를 합쳐 최대 300초까지 걸릴 수 있어요. 연결 오류 · 시간 초과 · 5xx 오류는 몇 초 쉬었다가 다시 보내고, 4xx 오류는 보낸 값을 고친 뒤 보내 주세요.</p></div>
        <div class="faq-row"><h4>같은 질문엔 같은 답</h4><p>같은 조항 · 같은 조건이면 같은 결과가 나오도록 맞춰 두었어요.</p></div>
        <div class="faq-row"><h4>키는 비밀번호처럼</h4><p>키를 남에게 보여 주거나 공개 저장소 · 문서에 적지 말아 주세요. 새어 나간 것 같다면 "API 키" 탭에서 바로 폐기하고 새로 만들어 주세요.</p></div>
        <div class="faq-row"><h4>지금 모델의 한계</h4><p>아주 긴 조항(약 130자 넘음)이나 여러 내용이 섞인 조항은 위험한 문구도 점수가 낮게 나올 수 있어요. 회피형 탐지는 공정한 조항도 주제(책임 · 환불 · 위약금)만으로 점수를 높게 줄 때가 있어요.</p></div>
        <div class="faq-row"><h4>처음 요청이 느린 이유</h4><p>5분 동안 쓰지 않으면 모델이 메모리에서 내려가요. 그다음 첫 요청은 모델을 다시 올리느라 10~30초 더 걸려요.</p></div>
        <template v-if="canManage">
          <div class="faq-row"><h4>[운영] 가상환경은 extra 와 함께</h4><p>가상환경을 다시 맞출 때는 반드시 <code>uv sync --frozen --extra classifiers</code>. extra 없이 돌리면 torch 가 지워져 편법 · 위법 탐지가 단순 규칙으로 조용히 바뀝니다(서버 상태 탭 모델 이름이 *-heuristic).</p></div>
          <div class="faq-row"><h4>[운영] 서버 키 관리</h4><p>모델 서버는 서버 안(127.0.0.1)에서만 받고, 서버 키(MODEL_API_KEY)는 model-server/.env · backend/.env 에만 둡니다. 이용자는 발급 키로 이 웹 서비스를 거쳐 부르므로 서버 키를 알 필요가 없습니다.</p></div>
        </template>
      </section>

      <!-- 매뉴얼 -->
      <section v-if="tab === 'manual'" role="tabpanel" class="stack">
        <div class="faq-row"><h4>기동 순서</h4><p>공유 Ollama(실행 중 확인만, serve 금지) → 게이트웨이(/health 가 모델 상태를 보고) → Node 백엔드.</p></div>
        <div class="faq-row">
          <h4>서비스 관리(launchd kr.crd.model-server)</h4>
          <p><code>cd model-server</code> 후 <code>./scripts/install_launchd.sh install | restart | status | uninstall</code>. 비정상 종료 시 10초 뒤 자동 재시작(실측 13초 복구). uvicorn 을 손으로 따로 띄우면 포트가 겹칩니다.</p>
        </div>
        <div class="faq-row"><h4>종합 점검</h4><p><code>.venv/bin/python scripts/service_test.py --out docs/service-test-result.json</code> — 19항목(M3·M4 호출 포함 약 20~30초). 결과는 문서·점검 결과 탭에 바로 보입니다.</p></div>
        <div class="faq-row"><h4>헬스체크</h4><p><code>curl -s -H "Authorization: Bearer $MODEL_API_KEY" http://127.0.0.1:9542/health</code> — 상태 표시가 미구현이면 이 명령으로 확인합니다.</p></div>
        <div class="faq-row"><h4>모델 교체·버전업</h4><p>새 revision 받기 → 변환 → 등록 → model_card.json 갱신 → 게이트웨이 재시작. 교체가 감지되면 서버 상태 탭이 탐지 품질 평가를 권합니다.</p></div>
        <div id="checklist" class="faq-row">
          <h4>장애 대응 체크리스트</h4>
          <ul class="bullets">
            <li>연결 불가(504·무응답): <code>./scripts/install_launchd.sh status</code>, <code>lsof -iTCP:9542</code>, 로그 <code>~/Library/Logs/crd-model-server.log</code> 확인 후 <code>restart</code></li>
            <li>모델 이름이 *-heuristic: <code>.env</code> 의 MODEL_ROOT, 가상환경 torch 확인(가이드라인 탭)</li>
            <li>모델 로딩 중(503)이 5분 넘게 지속: 공유 Ollama 의 다른 대형 모델 사용 여부, 메모리 확인</li>
            <li>API 키 불일치(401): backend/.env 와 모델 서버 키 일치 여부(값은 기록·공유하지 않음)</li>
            <li>missing: 서버 상태 탭의 수동 준비 절차 실행</li>
          </ul>
        </div>
      </section>

      <!-- 문서·점검 결과 -->
      <section v-if="tab === 'docs'" role="tabpanel" class="stack" data-panel="docs">
        <div class="tabs" role="group" aria-label="문서 선택">
          <button v-for="d in DOCS" :key="d[0]" type="button" class="tab" :aria-selected="docName === d[0] ? 'true' : 'false'" :data-doc="d[0]" @click="openDoc(d[0])">{{ d[1] }}</button>
        </div>
        <p v-if="docFailed" class="t-body-sm">문서를 불러오지 못했습니다.</p>
        <template v-else-if="doc">
          <p class="t-caption-sm muted">{{ doc.title }} · 갱신 {{ fmtTime(doc.updatedAt) }}</p>
          <template v-if="testResult">
            <p class="t-body-sm"><strong>{{ testResult.passed }}/{{ testResult.total }} 통과</strong> · {{ fmtTime(testResult.at) }} · {{ testResult.sec }}초 · {{ testResult.base }}</p>
            <div class="tablewrap">
              <table class="spec" data-part="test-result">
                <thead><tr><th>ID</th><th>항목</th><th>결과</th><th>시간</th><th>내용</th></tr></thead>
                <tbody>
                  <tr v-for="r in testResult.results" :key="r.id" :data-ok="r.ok">
                    <td class="mono">{{ r.id }}</td><td>{{ r.name }}</td>
                    <td><span :class="['status', r.ok ? 'ready' : 'down']"><i aria-hidden="true" />{{ r.ok ? '통과' : '실패' }}</span></td>
                    <td class="mono">{{ r.ms }}ms</td><td class="t-body-sm">{{ r.detail }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
          <pre v-else class="doc-md" data-part="doc-md">{{ doc.content }}</pre>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
[data-part='test-result'] .status { white-space: nowrap; }
.key-text { white-space: pre-wrap; word-break: break-all; }
.doc-md { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6; background: var(--color-surface-soft); border: 1px solid var(--color-hairline); border-radius: 8px; padding: 16px; max-height: 70vh; overflow: auto; }
</style>
