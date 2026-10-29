-- =====================================================================
-- crd_ddl_test.sql — crd_ddl.sql 위반 거부 검증 스크립트
-- 사용: 빈 스키마에 crd_ddl.sql 적용 후, 이 파일을 "-- @" 표지 단위로 한 문장씩 실행한다.
--   -- @setup   : 성공해야 하는 준비 데이터
--   -- @accept  : 성공해야 하는 정상 조작
--   -- @reject <규칙> : 실패(거부)해야 하는 위반 시도
--   -- @expect <값>  : 조회 결과 첫 칸이 <값> 이어야 한다(유도 속성·뷰 검증)
-- 실행기는 설계서 §16-6 에 적은 절차(스크립트)로 돌렸다. 예시 값은 모두 가상이다.
-- =====================================================================

-- @setup
INSERT INTO app_user (user_id, email, role) VALUES (1, 'user1@example.kr', 'user'), (2, 'op@example.kr', 'operator'), (3, 'expert@example.kr', 'legal_expert');
-- @setup
INSERT INTO anon_session (session_id, device_key) VALUES ('00000000-0000-0000-0000-000000000001', 'dev-A');
-- @setup
INSERT INTO knowledge_version (kv_id, kv_seq, knowledge_date, analysis_basis_version, status) VALUES (1, 1, '2026-07-10', 'v1.2', 'superseded'), (2, 2, '2026-09-15', 'v1.3', 'active');
-- @setup
INSERT INTO evidence_item (evidence_item_id, source_type, source_name, identifier) VALUES
 (1, 'law_article', '약관의 규제에 관한 법률', '제8조'),
 (2, 'std_terms', '온라인 강의 표준약관', '제15조'),
 (3, 'law_article', '전자상거래법 시행령', '제x조');
-- @setup
INSERT INTO evidence_version (evidence_version_id, evidence_item_id, from_kv_id, to_kv_id, excerpt, source_url, effective_date) VALUES
 (1, 1, 1, NULL, '고객에게 부당하게 과중한 지연 손해금 등의 손해배상 의무를 부담시키는 약관 조항은 무효로 한다', 'https://law.example/8', '2020-01-01'),
 (2, 2, 1, NULL, '표준약관 발췌', 'https://ftc.example/std15', '2021-01-01'),
 (3, 3, 1, 2, '개정 전 조문', 'https://law.example/x-old', '2019-01-01'),
 (4, 3, 2, NULL, '개정 후 조문', 'https://law.example/x-new', '2026-09-10');
-- @setup
INSERT INTO analysis_request (request_id, user_id, input_method, perspective, fixed_kv_id, stage) VALUES (1, 1, 'file', 'consumer', 1, 'type_confirmed');
-- @setup
INSERT INTO document (document_id, request_id, doc_seq, display_name, file_format, split_method, raw_file_ref, raw_delete_due_at, summary_status, summary_text, summary_model_version, contract_type_candidate, contract_type, contract_type_confirmed_at, is_contract)
VALUES (1, 1, 1, '온라인강의_이용약관', 'pdf', 'article', 's3://tmp/raw1', '2026-08-03 10:00:00', 'ok', '월 이용료 자동 결제, 계약 기간 12개월', 'm4-0.2.0', 'subscription', 'subscription', '2026-08-02 09:00:00', TRUE);
-- @setup
INSERT INTO clause (clause_id, document_id, seq, article_no, title, deid_text) VALUES
 (1, 1, 1, '제12조', '위약금', '회원이 중도 해지하면 잔여 기간 이용료의 3배를 위약금으로 낸다'),
 (2, 1, 2, '제13조', '통지', '〔이름〕은 변경 사항을 7일 전에 통지한다'),
 (3, 1, 3, '제14조', '관할', '분쟁은 회사 소재지 법원에서 다툰다');
-- @setup
INSERT INTO analysis_run (run_id, request_id, run_kind, kv_id, stage, started_at, completed_at, saved_at) VALUES (1, 1, 'analysis', 1, 'saved', '2026-08-02 09:00:00', '2026-08-02 09:03:00', '2026-08-02 09:04:00');
-- @setup
INSERT INTO judgment (judgment_id, text_hash, contract_type, perspective, kv_id, m3_model_version, m3_category, risk_type, risk_level, confidence, origin)
SELECT 1, text_hash, 'subscription', 'consumer', 1, 'm3-1.2.0', 'unfair', 'excessive_penalty', 'high', 'medium', 'service' FROM clause WHERE clause_id = 1;
-- @setup
INSERT INTO judgment (judgment_id, text_hash, contract_type, perspective, kv_id, m3_model_version, m3_category, risk_type, risk_level, confidence, origin)
SELECT 2, text_hash, 'subscription', 'consumer', 1, 'm3-1.2.0', 'illegal', 'rights_limit', 'mid', 'low', 'service' FROM clause WHERE clause_id = 3;
-- @setup
INSERT INTO judgment_evidence (judgment_id, evidence_version_id, display_rank) VALUES (1, 1, 1), (1, 2, 2);
-- @setup
INSERT INTO explanation_claim (judgment_id, seq, claim_text, evidence_version_id) VALUES (1, 1, '위약금이 잔여 이용료보다 과도하게 클 수 있습니다', 1);
-- @setup
INSERT INTO clause_assessment (assessment_id, run_id, clause_id, score_loophole, score_illegal, screen_result, judgment_id, status) VALUES
 (1, 1, 1, 0.9100, 0.4200, 'risk_candidate', 1, 'judged'),
 (2, 1, 2, 0.1000, 0.0500, 'normal_candidate', NULL, 'normal'),
 (3, 1, 3, 0.7000, 0.8000, 'risk_candidate', 2, 'judged');
-- @setup
INSERT INTO usage_charge (user_id, run_id, charged_at) VALUES (1, 1, CURRENT_TIMESTAMP);

-- ---------- 유도 속성·뷰 검증 ----------
-- @expect 64
SELECT LENGTH(text_hash) FROM clause WHERE clause_id = 1;
-- @expect unfair
SELECT display_category FROM v_assessment_display WHERE assessment_id = 1;
-- @expect dispute
SELECT display_category FROM v_assessment_display WHERE assessment_id = 3;
-- @expect 1
SELECT evidence_unconfirmed FROM v_assessment_display WHERE assessment_id = 3;
-- @expect 1
SELECT expert_review_recommended FROM v_assessment_display WHERE assessment_id = 3;
-- @expect 1
SELECT high_cnt FROM v_run_risk_counts WHERE run_id = 1;
-- @expect 2
SELECT remaining FROM v_quota_current WHERE user_id = 1;
-- @expect 3
SELECT evidence_version_id FROM v_evidence_in_force WHERE kv_id = 1 AND evidence_item_id = 3;
-- @expect 4
SELECT evidence_version_id FROM v_evidence_in_force WHERE kv_id = 2 AND evidence_item_id = 3;
-- @expect ***@***.kr
SELECT email_masked FROM v_user_masked WHERE user_id = 1;

-- ---------- 위반 시도 — 전부 거부되어야 한다 ----------
-- @reject BR-KNW-01 활성 기준일 단일성
INSERT INTO knowledge_version (kv_id, kv_seq, knowledge_date, analysis_basis_version, status) VALUES (3, 3, '2026-10-01', 'v1.3', 'active');
-- @reject 근거 규율 4 unknown 상수에 값
UPDATE policy_constant SET value_num = 0.5 WHERE const_key = 'DETECT_THRESHOLD_M1';
-- @reject BR-EVD-02 시행일·공개일 모두 없음
INSERT INTO evidence_version (evidence_item_id, from_kv_id, excerpt, source_url) VALUES (1, 2, 'x', 'https://x');
-- @reject BR-INP-01 입력 방식
INSERT INTO analysis_request (user_id, input_method, perspective, fixed_kv_id, stage) VALUES (1, 'email', 'consumer', 2, 'received');
-- @reject BR-HIS-01 소유자 없음
INSERT INTO analysis_request (input_method, perspective, fixed_kv_id, stage) VALUES ('text', 'consumer', 2, 'received');
-- @reject BR-INP-01 파일 형식
INSERT INTO document (request_id, doc_seq, display_name, file_format) VALUES (1, 2, 'x', 'xlsx');
-- @reject BR-INP-03 G6 계약서 아닌 문서의 유형 확정
INSERT INTO document (request_id, doc_seq, display_name, is_contract, contract_type, contract_type_confirmed_at) VALUES (1, 3, 'x', FALSE, 'subscription', CURRENT_TIMESTAMP);
-- @reject BR-PRV-02 원본 삭제 후 위치 참조 잔존
UPDATE document SET raw_deleted_at = CURRENT_TIMESTAMP WHERE document_id = 1;
-- @reject BR-ANL-05 최초 분석 기준일 불일치
INSERT INTO analysis_run (request_id, run_kind, kv_id, stage) VALUES (1, 'analysis', 2, 'detecting');
-- @reject UC5 재분석 이전 결과 없음
INSERT INTO analysis_run (request_id, run_kind, prev_run_id, kv_id, stage) VALUES (1, 'reanalysis', 999, 2, 'detecting');
-- @reject BR-ANL-01 위험 판정에 위험도 없음
INSERT INTO judgment (text_hash, contract_type, perspective, kv_id, m3_model_version, m3_category, origin) VALUES (REPEAT('a',64), 'subscription', 'consumer', 1, 'm3-1.2.0', 'unfair', 'service');
-- @reject BR-MDL-04 캐시 키 중복
INSERT INTO judgment (text_hash, contract_type, perspective, kv_id, m3_model_version, m3_category, risk_type, risk_level, confidence, origin)
SELECT text_hash, 'subscription', 'consumer', 1, 'm3-1.2.0', 'dispute', 'vague', 'low', 'low', 'service' FROM clause WHERE clause_id = 1;
-- @reject BR-ANL-02 판정 불변
UPDATE judgment SET risk_level = 'low' WHERE judgment_id = 1;
-- @accept UC3 E3 설명 재생성 1회
UPDATE judgment SET explanation_regen_count = 1 WHERE judgment_id = 1;
-- @reject UC3 E3 재생성 2회
UPDATE judgment SET explanation_regen_count = 2 WHERE judgment_id = 1;
-- @reject BR-EVD-03 기준일에 유효하지 않은 근거(개정 후 조문을 kv1 판정에)
INSERT INTO judgment_evidence (judgment_id, evidence_version_id, display_rank) VALUES (1, 4, 3);
-- @reject BR-EXP-04 판정 근거에 없는 근거로 주장 연결
INSERT INTO explanation_claim (judgment_id, seq, claim_text, evidence_version_id) VALUES (1, 2, '주장', 3);
-- @reject BR-ANL-04 분석 불가인데 사유 없음
INSERT INTO clause_assessment (run_id, clause_id, status) VALUES (1, 2, 'unanalyzable');
-- @reject BR-MDL-04 캐시 키가 조항과 다른 판정 연결
UPDATE clause_assessment SET judgment_id = 2 WHERE assessment_id = 1;
-- @accept 재분석 실행 시작(최신 기준일, 이전 저장 결과 참조)
INSERT INTO analysis_run (run_id, request_id, run_kind, prev_run_id, kv_id, stage) VALUES (2, 1, 'reanalysis', 1, 2, 'detecting');
-- @reject BR-MDL-03 진행 중 결과에 차감
INSERT INTO usage_charge (user_id, run_id) VALUES (1, 2);
-- @reject 한 결과 이중 차감
INSERT INTO usage_charge (user_id, run_id) VALUES (1, 1);
-- @reject 5.2 위험 판정에 미탐 피드백
INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, user_id) VALUES (1, 1, 1, 'unfair', 'false_negative', 1);
-- @reject BR-FDB-01 기준일 불일치 피드백
INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, user_id) VALUES (1, 1, 2, 'unfair', 'false_positive', 1);
-- @reject BR-FDB-01 강등된 표시 판정과 다른 제출 판정
INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, user_id) VALUES (3, 2, 1, 'illegal', 'false_positive', 1);
-- @accept 정상 피드백(오탐)
INSERT INTO feedback (feedback_id, assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, opinion_deid, user_id) VALUES (1, 1, 1, 1, 'unfair', 'false_positive', '업계에서 흔한 조항입니다. 담당자 〔이름〕', 1);
-- @accept 정상 피드백(미탐)
INSERT INTO feedback (feedback_id, assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, user_id) VALUES (2, 2, NULL, 1, 'normal', 'false_negative', 1);
-- @reject 8.4 검토 완료인데 판단 없음
UPDATE feedback SET review_status = 'reviewed' WHERE feedback_id = 1;
-- @reject UC9 A2 미검토 피드백을 평가 후보로
INSERT INTO eval_candidate (feedback_id, clause_text_deid, contract_type) VALUES (1, '회원이 중도 해지하면', 'subscription');
-- @accept 검토 기록(타당)
UPDATE feedback SET review_status = 'reviewed', review_decision = 'valid' WHERE feedback_id = 1;
-- @setup
INSERT INTO gate_event (event_id, gate_code, reason_code, feedback_id) VALUES (100, 'G13', 'unmasked_phone', 1);
-- @reject G13 가림 처리 중 평가 후보 지정
INSERT INTO eval_candidate (feedback_id, clause_text_deid, contract_type) VALUES (1, '회원이 중도 해지하면', 'subscription');
-- @accept G13 해제(시스템 가림 완료)
UPDATE gate_event SET released_at = CURRENT_TIMESTAMP, release_action = 'masked_by_system' WHERE event_id = 100;
-- @accept H5 평가 후보 지정
INSERT INTO eval_candidate (candidate_id, feedback_id, clause_text_deid, contract_type) VALUES (1, 1, '회원이 중도 해지하면 잔여 기간 이용료의 3배를 위약금으로 낸다', 'subscription');
-- @reject G13 보안 사고 유형 외 값
INSERT INTO security_incident (feedback_id, detected_field, pii_type) VALUES (1, 'opinion', 'passport');
-- @reject BR-QA-01 인위적 변형 조항 채택
INSERT INTO eval_item (clause_text_deid, contract_type, gold_category, origin, review_status, reviewer_user_id, reviewed_at) VALUES ('변형', 'subscription', 'unfair', 'synthetic', 'accepted', 3, CURRENT_TIMESTAMP);
-- @reject BR-QA-01 검수자 없는 채택
INSERT INTO eval_item (clause_text_deid, contract_type, gold_category, origin, review_status) VALUES ('조항', 'subscription', 'unfair', 'new_label', 'accepted');
-- @accept 평가 데이터(후보 출신, 채택)
INSERT INTO eval_item (eval_item_id, clause_text_deid, contract_type, gold_category, origin, candidate_id, review_status, reviewer_user_id, reviewed_at) VALUES (1, '회원이 중도 해지하면', 'subscription', 'unfair', 'feedback_candidate', 1, 'accepted', 3, CURRENT_TIMESTAMP);
-- @setup
INSERT INTO eval_run (eval_run_id, kv_id, m1_model_version, m2_model_version, m3_model_version, stage) VALUES (1, 2, 'm1-0.4.2', 'm2-0.4.1', 'm3-1.2.0', 'result');
-- @setup
INSERT INTO eval_run_item (eval_run_id, eval_item_id, eligibility, predicted_category) VALUES (1, 1, 'included', 'unfair');
-- @setup
INSERT INTO eval_evidence_review (eval_run_id, eval_item_id, evidence_version_id) VALUES (1, 1, 1);
-- @reject UC8 E6 타임아웃 조항에 예측
UPDATE eval_run_item SET timed_out = TRUE WHERE eval_run_id = 1 AND eval_item_id = 1;
-- @reject G11 판정 대기 중 성공 기준 확정
UPDATE eval_run SET sc_confirmed_at = CURRENT_TIMESTAMP WHERE eval_run_id = 1;
-- @accept 전문가 회신
UPDATE eval_evidence_review SET verdict = 'relevant', reviewer_user_id = 3, responded_at = CURRENT_TIMESTAMP WHERE eval_run_id = 1;
-- @reject G12 최소 조항 수 미정(측정 불가)인 채 확정
UPDATE eval_run SET sc_confirmed_at = CURRENT_TIMESTAMP WHERE eval_run_id = 1;
-- @expect 100.00
SELECT recall_pct FROM v_eval_metric_live WHERE eval_run_id = 1;
-- @reject G12 측정 불가 유형에 지표 저장
INSERT INTO eval_metric (eval_run_id, contract_type, clause_count, timeout_excluded, recall_pct, measurable) VALUES (1, 'subscription', 1, 0, 100, FALSE);
-- @reject UC8 E6 중단 평가 기록
INSERT INTO eval_run (kv_id, m1_model_version, m2_model_version, m3_model_version, stage, recorded_at) VALUES (2, 'a', 'b', 'c', 'aborted', CURRENT_TIMESTAMP);
-- @setup
INSERT INTO ingest_batch (batch_id, base_kv_id, stage) VALUES (1, 2, 'selecting');
-- @reject G1 분리 실패 항목 포함
INSERT INTO ingest_item (batch_id, agency, item_title, change_kind, published_date, parse_status, parse_fail_reason, include_flag) VALUES (1, 'ftc', '공정위 의결', 'new_case', '2026-09-21', 'failed', '3구분 실패', TRUE);
-- @reject G0 수집 실패인데 새 기준일
UPDATE ingest_batch SET stage = 'collect_failed', approved_at = CURRENT_TIMESTAMP, result_kv_id = 2 WHERE batch_id = 1;
-- @reject 게이트 대상 누락(G6 요청 없음)
INSERT INTO gate_event (gate_code, reason_code, user_id) VALUES ('G6', 'not_contract', 1);
-- @reject 게이트 해제 기록 불완전
INSERT INTO gate_event (gate_code, reason_code, request_id, released_at) VALUES ('G6', 'not_contract', 1, CURRENT_TIMESTAMP);
-- @accept G9 설명 제공 불가 기록
INSERT INTO gate_event (gate_code, reason_code, judgment_id) VALUES ('G9', 'regen_failed', 1);
-- @expect 0
SELECT explanation_available FROM v_assessment_display WHERE assessment_id = 1;
-- @reject UC2 A9 판정된 조항의 판정 교체
UPDATE clause_assessment SET judgment_id = NULL, status = 'unanalyzable', unanalyzable_reason = 'timeout' WHERE assessment_id = 1;

-- ---------- 영구 삭제(BR-PRV-03)와 잔존 기록 ----------
-- @accept 사용자 기록 삭제
DELETE FROM analysis_request WHERE request_id = 1;
-- @expect 0
SELECT COUNT(*) FROM clause;
-- @expect 1
SELECT COUNT(*) FROM usage_charge WHERE user_id = 1 AND run_id IS NULL;
-- @expect 2
SELECT COUNT(*) FROM feedback WHERE assessment_id IS NULL;
