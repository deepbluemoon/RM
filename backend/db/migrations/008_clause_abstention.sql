-- =====================================================================
-- 008_clause_abstention.sql — 판정 불가(2026-09-30, 사용자 결정 "가": 새 테이블)
-- 잘못된 입력·계약 조항이 아닌 문장·모델 지시문은 M1·M2·M3 를 부르지 않고 여기에 사유를 남긴다.
-- clause_assessment 는 DDL 제약(unanalyzable 사유 = timeout·server_down) 때문에 status 'normal' 로 닫고,
-- 결과 화면(results.service)이 이 표를 겹쳐 "판정 불가"로 보여 준다. design/crd_ddl.sql·뷰는 바꾸지 않는다.
-- 관문 1 = 규칙(abstention/rules.ts), 관문 2 = 계약 조항다움 점수(evidence/search.ts clauseLikeness, 기준 ABSTAIN_LIKENESS_MIN)
-- 멱등: CREATE TABLE IF NOT EXISTS
-- =====================================================================

CREATE TABLE IF NOT EXISTS clause_abstention (
  run_id      BIGINT        NOT NULL,
  clause_id   BIGINT        NOT NULL,
  reason      VARCHAR(20)   NOT NULL,     -- invalid_input · not_clause · prompt_injection
  code        VARCHAR(20)   NOT NULL,     -- 세부 사유(too_short·garbled·repeated·symbols·header_only·not_korean·injection·low_likeness)
  gate        TINYINT       NOT NULL,     -- 1 규칙 · 2 계약 조항다움
  score       DECIMAL(6,4)  NULL,         -- 관문 2 점수(관문 1 은 NULL)
  created_at  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_clause_abstention PRIMARY KEY (run_id, clause_id),
  CONSTRAINT fk_cab_run FOREIGN KEY (run_id) REFERENCES analysis_run (run_id) ON DELETE CASCADE,
  CONSTRAINT fk_cab_clause FOREIGN KEY (clause_id) REFERENCES clause (clause_id) ON DELETE CASCADE,
  CONSTRAINT chk_cab_reason CHECK (reason IN ('invalid_input', 'not_clause', 'prompt_injection')),
  CONSTRAINT chk_cab_gate CHECK (gate IN (1, 2))
);
