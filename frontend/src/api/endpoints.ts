// 계약(contracts/web-api.openapi.yaml)의 operation 과 1:1. 경로·본문은 계약을 따른다.
import { http, qs, API_BASE } from './client'
import type * as T from './types'

export const api = {
  // session · auth (RBAC)
  session: () => http.get<T.SessionInfo>('/session'),
  logout: () => http.post<void>('/auth/logout'),
  /** 아이디·비밀번호 로그인·회원가입(2026-09-30) */
  login: (loginId: string, password: string, returnTo: string) => http.post<T.LoginResult>('/auth/login', { loginId, password, returnTo }),
  signup: (loginId: string, password: string, name: string, returnTo: string) => http.post<T.LoginResult>('/auth/signup', { loginId, password, name, returnTo }),

  // meta
  privacyNotice: () => http.get<{ html?: string }>('/meta/privacy-notice'),
  modelServerStatus: () => http.get<T.ModelServerStatus>('/model-server/status'),

  // intake (P1)
  upload: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.post<T.PrecheckResult>('/intake/uploads', fd)
  },
  fetchUrl: (url: string) => http.post<T.UrlFetchResult>('/intake/url-fetches', { url }),
  createAnalysis: (perspective: T.Perspective, source: T.AnalysisSource) =>
    http.post<T.CreateAnalysisResult>('/analyses', { perspective, source }),

  // analysis (P2·P3)
  analysisStatus: (requestId: number) => http.get<T.AnalysisStatus>(`/analyses/${requestId}`),
  confirmContractType: (requestId: number, documentId: number, contractType: T.ContractType) =>
    http.put<T.AnalysisStatus>(`/analyses/${requestId}/documents/${documentId}/contract-type`, { contractType }),
  saveRun: (requestId: number, runId: number) => http.post<T.SaveResult>(`/analyses/${requestId}/runs/${runId}/save`),
  cancelAnalysis: (requestId: number) => http.post<T.CancelResult>(`/analyses/${requestId}/cancel`),

  // results (P4)
  result: (runId: number) => http.get<T.ResultView>(`/results/${runId}`),
  clause: (runId: number, assessmentId: number) => http.get<T.ClauseDetail>(`/results/${runId}/clauses/${assessmentId}`),
  explanation: (runId: number, assessmentId: number) =>
    http.get<T.Explanation>(`/results/${runId}/clauses/${assessmentId}/explanation`),
  comparison: (runId: number, assessmentId: number) =>
    http.get<T.Comparison>(`/results/${runId}/clauses/${assessmentId}/comparison`),
  similarCases: (runId: number, assessmentId: number) =>
    http.get<T.FtcCase[]>(`/results/${runId}/clauses/${assessmentId}/similar-cases`),
  rejudge: (runId: number, assessmentId: number) =>
    http.post<T.ClauseDetail>(`/results/${runId}/clauses/${assessmentId}/rejudge`),
  impacts: (runId: number) => http.get<T.ResultImpact[]>(`/results/${runId}/impacts`),
  evidence: (evidenceVersionId: number) => http.get<T.Evidence>(`/evidence/${evidenceVersionId}`),

  // feedback (P5)
  feedbackPreview: (opinion: string) => http.post<T.FeedbackPreview>('/feedback/preview', { opinion }),
  submitFeedback: (body: { assessmentId: number; feedbackType: 'false_positive' | 'false_negative'; opinion?: string }) =>
    http.post<T.FeedbackCreated>('/feedback', body),

  // history (P6)
  history: (cursor?: string | null, limit = 20) => http.get<T.HistoryList>(`/history${qs({ cursor, limit })}`),
  historyDetail: (requestId: number) => http.get<T.HistoryDetail>(`/history/${requestId}`),
  deleteHistory: (requestId: number) => http.del(`/history/${requestId}`),
  reanalyze: (requestId: number, prevRunId: number) =>
    http.post<T.ReanalysisResult>(`/history/${requestId}/reanalyses`, { prevRunId }),

  // admin: knowledge (P0)
  knowledgeVersions: () => http.get<T.KnowledgeVersion[]>('/admin/knowledge/versions'),
  startIngest: () => http.post<{ batchId?: number }>('/admin/knowledge/ingest-batches'),
  ingestBatch: (batchId: number) => http.get<T.IngestBatch>(`/admin/knowledge/ingest-batches/${batchId}`),
  retryIngest: (batchId: number) => http.post<void>(`/admin/knowledge/ingest-batches/${batchId}/retry`),
  setIngestItem: (batchId: number, itemId: number, include: boolean) =>
    http.patch<void>(`/admin/knowledge/ingest-batches/${batchId}/items/${itemId}`, { include }),
  approveIngest: (batchId: number) => http.post<T.ApproveResult>(`/admin/knowledge/ingest-batches/${batchId}/approve`),

  // admin: eval (P7)
  evalOverview: () => http.get<T.EvalOverview>('/admin/eval/overview'),
  evalItems: (reviewStatus?: 'pending' | 'accepted' | 'rejected') =>
    http.get<T.EvalItem[]>(`/admin/eval/items${qs({ reviewStatus })}`),
  reviewEvalItem: (evalItemId: number, decision: 'accepted' | 'rejected') =>
    http.post<void>(`/admin/eval/items/${evalItemId}/review`, { decision }),
  startEvalRun: (evalItemIds?: number[]) => http.post<{ evalRunId?: number }>('/admin/eval/runs', { evalItemIds }),
  evalRun: (evalRunId: number) => http.get<T.EvalRun>(`/admin/eval/runs/${evalRunId}`),
  evidenceReviews: (evalRunId: number) =>
    http.get<T.EvidenceReviewSample[]>(`/admin/eval/runs/${evalRunId}/evidence-reviews`),
  putEvidenceReview: (evalRunId: number, evalItemId: number, evidenceVersionId: number, verdict: 'relevant' | 'irrelevant') =>
    http.put<void>(`/admin/eval/runs/${evalRunId}/evidence-reviews/${evalItemId}/${evidenceVersionId}`, { verdict }),
  recordEvalRun: (evalRunId: number) => http.post<void>(`/admin/eval/runs/${evalRunId}/record`),
  confirmEvalRun: (evalRunId: number) => http.post<void>(`/admin/eval/runs/${evalRunId}/confirm`),
  compareEval: (a: number, b: number) => http.get<Record<string, unknown>>(`/admin/eval/compare${qs({ a, b })}`),

  // admin: feedback (P8)
  adminFeedback: (f: { type?: string; kvId?: number; reviewStatus?: string }) =>
    http.get<T.FeedbackRow[]>(`/admin/feedback${qs(f)}`),
  adminFeedbackSummary: () => http.get<Record<string, unknown>[]>('/admin/feedback/summary'),
  adminFeedbackDetail: (feedbackId: number) => http.get<T.FeedbackDetail>(`/admin/feedback/${feedbackId}`),
  reviewFeedback: (feedbackId: number, decision: 'valid' | 'invalid' | 'needs_expert') =>
    http.post<void>(`/admin/feedback/${feedbackId}/review`, { decision }),
  makeEvalCandidate: (feedbackId: number) => http.post<void>(`/admin/feedback/${feedbackId}/eval-candidate`),

  // admin: model API (P9)
  modelApiStatus: () => http.get<T.ModelApiStatus>('/admin/model-api/status'),
  modelApiOpenapiUrl: () => `${API_BASE}/admin/model-api/openapi`,
  modelApiDoc: (name: T.ModelDocName) => http.get<T.ModelDoc>(`/admin/model-api/docs/${name}`),

  // API 키(2026-09-30) — 원문은 발급 응답에서 한 번만
  apiKeys: () => http.get<{ items: T.ApiKey[] }>('/api-keys'),
  issueApiKey: (name: string) => http.post<T.ApiKey & { key: string }>('/api-keys', { name }),
  revokeApiKey: (keyId: number) => http.del(`/api-keys/${keyId}`),
  adminApiKeys: () => http.get<{ items: T.AdminApiKey[] }>('/admin/api-keys'),
  adminRevokeApiKey: (keyId: number) => http.del(`/admin/api-keys/${keyId}`),
}
