// schema.d.ts(생성물)에서 화면이 쓰는 타입 별칭만 모은다. schema.d.ts 는 `npm run gen:api` 로만 갱신한다.
import type { components, paths } from './schema'

type S = components['schemas']
export type Perspective = S['Perspective']
export type ContractType = S['ContractType']
export type RiskCategory = S['RiskCategory']
export type DisplayCategory = S['DisplayCategory']
export type RiskType = S['RiskType']
export type RiskLevel = S['RiskLevel']
export type Confidence = S['Confidence']
export type PiiType = S['PiiType']
export type Problem = S['Problem']
export type GateErrorBody = S['GateError']
export type OpenGate = S['OpenGate']
export type Quota = S['Quota']
export type SessionInfo = S['SessionInfo']
export type AuthProvider = NonNullable<SessionInfo['authProviders']>[number]
export type UserRole = NonNullable<NonNullable<SessionInfo['user']>['role']>
/** RBAC 권한(유스케이스 단위) — 판정 원천은 서버 backend/src/modules/auth/rbac.ts */
export type Permission = S['Permission']
export type LoginResult = S['LoginResult']
export type ApiKey = S['ApiKey']
export type AdminApiKey = S['AdminApiKey']
export type RoleMatrix = S['RoleMatrix']
export type RbacView = S['RbacView']
export type PrecheckItem = S['PrecheckItem']
export type PrecheckResult = S['PrecheckResult']
export type AnalysisStatus = S['AnalysisStatus']
export type RailSubStep = NonNullable<AnalysisStatus['rail']>[number]
export type AnalysisDocument = NonNullable<AnalysisStatus['documents']>[number]
export type ModelNotice = NonNullable<AnalysisStatus['modelNotice']>
export type ClauseNode = S['ClauseNode']
export type ResultView = S['ResultView']
export type ResultDocument = NonNullable<ResultView['documents']>[number]
export type Evidence = S['Evidence']
export type ClauseDetail = S['ClauseDetail']
export type Explanation = S['Explanation']
export type Comparison = S['Comparison']
export type FtcCase = S['FtcCase']
export type ResultImpact = S['ResultImpact']
export type HistoryItem = S['HistoryItem']
export type HistoryDetail = S['HistoryDetail']
export type KnowledgeVersion = S['KnowledgeVersion']
export type IngestBatch = S['IngestBatch']
export type IngestItem = NonNullable<IngestBatch['items']>[number]
export type EvalItem = S['EvalItem']
export type EvalMetric = S['EvalMetric']
export type EvalRun = S['EvalRun']
export type FeedbackRow = S['FeedbackRow']
export type FeedbackDetail = S['FeedbackDetail']
export type ModelApiStatus = S['ModelApiStatus']

type JsonOf<P extends keyof paths, M extends keyof paths[P], C extends number> =
  paths[P][M] extends { responses: infer R }
    ? C extends keyof R
      ? R[C] extends { content: { 'application/json': infer B } }
        ? B
        : never
      : never
    : never

export type ModelServerStatus = JsonOf<'/model-server/status', 'get', 200>
export type ModelServerModelState = NonNullable<ModelServerStatus['models']>[number]
export type UrlFetchResult = JsonOf<'/intake/url-fetches', 'post', 201>
export type CreateAnalysisResult = JsonOf<'/analyses', 'post', 201>
export type CancelResult = JsonOf<'/analyses/{requestId}/cancel', 'post', 200>
export type SaveResult = JsonOf<'/analyses/{requestId}/runs/{runId}/save', 'post', 200>
export type HistoryList = JsonOf<'/history', 'get', 200>
export type ReanalysisResult = JsonOf<'/history/{requestId}/reanalyses', 'post', 202>
export type FeedbackPreview = JsonOf<'/feedback/preview', 'post', 200>
export type FeedbackCreated = JsonOf<'/feedback', 'post', 201>
export type ApproveResult = JsonOf<'/admin/knowledge/ingest-batches/{batchId}/approve', 'post', 200>

export type AnalysisSource =
  | { kind: 'file'; uploadToken: string }
  | { kind: 'url'; sourceToken: string }
  | { kind: 'text'; text: string }

/**
 * `/admin/eval/overview` 는 계약상 additionalProperties 다. 화면이 기대하는 필드(가정 — 백엔드와 맞출 것).
 */
export interface EvalOverview {
  knowledgeDate?: string
  kvId?: number
  analysisBasisVersion?: string
  modelVersions?: { m1?: string; m2?: string; m3?: string; m4?: string }
  trainedDataDates?: { m1?: string | null; m2?: string | null; m3?: string | null }
  acceptedByType?: { contractType: ContractType; count: number }[]
  pendingReviewCount?: number
  recordedRuns?: { evalRunId: number; recordedAt?: string; m3?: string; knowledgeDate?: string }[]
}

/** `/admin/eval/runs/{id}/evidence-reviews` 항목(계약상 additionalProperties — 가정 필드). */
export interface EvidenceReviewSample {
  evalItemId: number
  evidenceVersionId: number
  clauseTextDeid?: string
  displayCategory?: DisplayCategory
  riskType?: RiskType
  riskLevel?: RiskLevel
  confidence?: Confidence
  evidence?: Evidence
  verdict?: 'relevant' | 'irrelevant' | null
}

// S9 모델 서버 운영 문서(GET /admin/model-api/docs/{name})
export type ModelDocName = 'guideline' | 'manual' | 'test-result' | 'model-test'
export interface ServiceTestItem { id: string; name: string; ok: boolean; ms: number; detail: string }
export interface ServiceTestResult { base: string; at: string; passed: number; total: number; sec: number; results: ServiceTestItem[] }
export interface ModelDoc {
  name: ModelDocName
  title: string
  format: 'markdown' | 'json'
  updatedAt: string
  content: string | ServiceTestResult
}
