-- =====================================================================
-- crd_ddl.sql — 계약위험탐지서비스(Contract Risk Detection) 데이터베이스 DDL
-- 설계서: design/SD_03_데이터베이스설계서_계약위험탐지서비스.md
-- 작성일: 2026-09-28
--
-- 규약
--   * 표준 SQL 을 기본으로 한다. DBMS 전용 구문은 [DBMS] 주석으로 표시하고 이유를 적었다.
--   * 검증 DBMS: MariaDB 12.0.2 (로컬 격리 인스턴스). 검증 3종 — 무오류 실행 · 재실행(멱등) · 위반 거부 —
--     결과는 설계서 §16-6 에 있다.
--   * 생성 순서는 FK 의존 위상 정렬이다: 코드·정책 → 이용자 → 지식·근거 → 갱신 작업 → 분석 입력 →
--     판정·결과 → 한도·영향 → 피드백 → 품질 평가 → 게이트 이벤트 → 뷰 → 트리거 → 기준 데이터.
--   * 멱등: CREATE TABLE IF NOT EXISTS · CREATE INDEX IF NOT EXISTS · CREATE OR REPLACE VIEW ·
--     DROP TRIGGER IF EXISTS 후 CREATE · 기준 데이터는 INSERT … SELECT … WHERE NOT EXISTS.
--
-- [DBMS] 공통 이탈 사항
--   1) 대리키 AUTO_INCREMENT — 표준 GENERATED … AS IDENTITY 를 MariaDB 가 지원하지 않는다.
--   2) TEXT — 표준 CLOB 대신. 조항 원문·설명 길이 상한이 원천에 없다.
--   3) SHA2(), DATEDIFF(), CONCAT(), SUBSTRING_INDEX() — 표준 SQL 에 해시·날짜차·문자 분할 함수가 없다.
--   4) 트리거 본문(DELIMITER · SIGNAL) — 트리거 문법은 DBMS 마다 다르다. 이식 시 본문만 바꾼다.
--   5) CREATE INDEX IF NOT EXISTS — 표준에 IF NOT EXISTS 가 없다. 멱등 실행을 위해 썼다.
-- 설계 이탈 기록(실행 중 논리 설계와 달라진 곳)은 파일 끝 [이탈 기록] 에 있다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- G. 공통 — 코드·정책 상수 (다른 모든 테이블보다 먼저)
-- ---------------------------------------------------------------------

-- 정책 상수. 원천에 값이 없는 상수는 행은 두고 value_num 을 비운다(status='unknown').
CREATE TABLE IF NOT EXISTS policy_constant (
  const_key    VARCHAR(40)   NOT NULL,
  value_num    DECIMAL(12,2) NULL,
  unit         VARCHAR(20)   NOT NULL,
  source_ref   VARCHAR(120)  NOT NULL,
  status       VARCHAR(10)   NOT NULL,
  CONSTRAINT pk_policy_constant PRIMARY KEY (const_key),
  CONSTRAINT chk_pc_status CHECK (status IN ('confirmed','assumed','unknown')),
  -- 근거 규율 4: 값이 없으면 unknown, unknown 이면 값이 없다
  CONSTRAINT chk_pc_unknown_empty CHECK (
    (status = 'unknown' AND value_num IS NULL) OR (status <> 'unknown' AND value_num IS NOT NULL))
);

-- 게이트 카탈로그. SD_01 §14-1 의 15개, 문구는 SD_02 §14-2 문구 사전(규칙 ④ 동일 문구)을 한 곳에 둔다.
CREATE TABLE IF NOT EXISTS gate_def (
  gate_code     VARCHAR(3)   NOT NULL,
  gate_name     VARCHAR(60)  NOT NULL,
  ipo_steps     VARCHAR(60)  NOT NULL,
  block_scope   VARCHAR(8)   NOT NULL,
  release_actor VARCHAR(20)  NOT NULL,
  title_text    VARCHAR(120) NOT NULL,
  CONSTRAINT pk_gate_def PRIMARY KEY (gate_code),
  CONSTRAINT chk_gd_scope CHECK (block_scope IN ('full','partial')),
  CONSTRAINT chk_gd_actor CHECK (release_actor IN ('user','operator','legal_expert','system','operator_expert'))
);

-- 계약 유형 코드. FR-013 의 6종. in_scope = FALSE 이면 "전문가 검토 권장"(BR-EXP-03)
CREATE TABLE IF NOT EXISTS contract_type_code (
  contract_type VARCHAR(20) NOT NULL,
  label_ko      VARCHAR(30) NOT NULL,
  in_scope      BOOLEAN     NOT NULL,
  CONSTRAINT pk_contract_type_code PRIMARY KEY (contract_type)
);

-- ---------------------------------------------------------------------
-- A. 이용자·세션
-- ---------------------------------------------------------------------

-- 로그인 이용자. 인증 방식은 미해결 6 — 인증 수단 컬럼은 두지 않았다.
CREATE TABLE IF NOT EXISTS app_user (
  user_id     BIGINT       NOT NULL AUTO_INCREMENT,           -- [DBMS] 1)
  email       VARCHAR(254) NOT NULL,
  role        VARCHAR(12)  NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_app_user PRIMARY KEY (user_id),
  CONSTRAINT uq_app_user_email UNIQUE (email),
  -- BR-API-01 · G14: 권한 구분. legal_expert 는 SD_02 S7-E [추론] — 미해결 U-2
  CONSTRAINT chk_user_role CHECK (role IN ('user','operator','developer','legal_expert'))
);

-- 비로그인 세션. BR-INP-04 "비로그인은 동일 기기·세션 기준", BR-HIS-01 "세션에서만 제공"
CREATE TABLE IF NOT EXISTS anon_session (
  session_id  CHAR(36)    NOT NULL,
  device_key  VARCHAR(64) NOT NULL,
  created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TIMESTAMP   NULL,        -- 세션 유효기간은 원천에 없다(미해결 P-2) — 값은 앱이 넣는다
  CONSTRAINT pk_anon_session PRIMARY KEY (session_id)
);
CREATE INDEX IF NOT EXISTS ix_session_device ON anon_session (device_key);   -- [DBMS] 5)

-- ---------------------------------------------------------------------
-- D. 지식 기준일·근거
-- ---------------------------------------------------------------------

-- H0 지식 기준일 스냅샷. 활성 기준일은 하나뿐이다.
CREATE TABLE IF NOT EXISTS knowledge_version (
  kv_id                  INT         NOT NULL AUTO_INCREMENT,  -- [DBMS] 1)
  kv_seq                 INT         NOT NULL,
  knowledge_date         DATE        NOT NULL,
  analysis_basis_version VARCHAR(20) NOT NULL,                -- H0 필수 항목 "분석 기준 버전"
  status                 VARCHAR(12) NOT NULL,
  created_at             TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 유도 컬럼: 활성 기준일 단일성 보장용 표지. active 이면 1, 아니면 NULL(NULL 은 UNIQUE 에서 중복 허용)
  active_marker          SMALLINT GENERATED ALWAYS AS (CASE WHEN status = 'active' THEN 1 ELSE NULL END) STORED,
  CONSTRAINT pk_knowledge_version PRIMARY KEY (kv_id),
  CONSTRAINT uq_kv_seq UNIQUE (kv_seq),
  CONSTRAINT uq_kv_date UNIQUE (knowledge_date),
  CONSTRAINT uq_kv_single_active UNIQUE (active_marker),     -- BR-KNW-01: 신규 분석이 쓸 기준일은 하나
  CONSTRAINT chk_kv_status CHECK (status IN ('active','superseded'))
);

-- 근거 항목(논리적 정체성). 버전이 바뀌어도 같은 조문·사건·표준약관 조항은 같은 항목이다.
CREATE TABLE IF NOT EXISTS evidence_item (
  evidence_item_id BIGINT       NOT NULL AUTO_INCREMENT,
  source_type      VARCHAR(12)  NOT NULL,
  source_name      VARCHAR(200) NOT NULL,   -- 법령명·사건명·표준약관명 (BR-EVD-02)
  identifier       VARCHAR(200) NOT NULL,   -- 조·항·호 번호 또는 사건번호·의결일 (BR-EVD-02)
  CONSTRAINT pk_evidence_item PRIMARY KEY (evidence_item_id),
  CONSTRAINT uq_evidence_item UNIQUE (source_type, source_name, identifier),
  CONSTRAINT chk_ei_type CHECK (source_type IN ('law_article','ftc_case','std_terms'))
);

-- 근거 버전. [from_kv, to_kv) 구간의 지식 기준일에서 유효. 기준일별 보관(SD_01 §3-3).
CREATE TABLE IF NOT EXISTS evidence_version (
  evidence_version_id BIGINT       NOT NULL AUTO_INCREMENT,
  evidence_item_id    BIGINT       NOT NULL,
  from_kv_id          INT          NOT NULL,
  to_kv_id            INT          NULL,
  excerpt             TEXT         NOT NULL,     -- 원문 발췌 (BR-EVD-02)  [DBMS] 2)
  source_url          VARCHAR(500) NOT NULL,     -- 원문 출처 링크 (BR-EVD-02)
  effective_date      DATE         NULL,         -- 시행일 (법령·표준약관)
  published_date      DATE         NULL,         -- 공개일 (사례)
  case_facts          TEXT         NULL,         -- 공정위 사례 3구분 (UC3 기본흐름 5, FR-036)
  case_judgment       TEXT         NULL,
  case_basis          TEXT         NULL,
  CONSTRAINT pk_evidence_version PRIMARY KEY (evidence_version_id),
  CONSTRAINT fk_ev_item FOREIGN KEY (evidence_item_id) REFERENCES evidence_item (evidence_item_id),
  CONSTRAINT fk_ev_from FOREIGN KEY (from_kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT fk_ev_to   FOREIGN KEY (to_kv_id)   REFERENCES knowledge_version (kv_id),
  CONSTRAINT uq_ev_item_from UNIQUE (evidence_item_id, from_kv_id),
  -- BR-EVD-02: 시행일 또는 공개일 중 하나는 반드시 있다
  CONSTRAINT chk_ev_date CHECK (effective_date IS NOT NULL OR published_date IS NOT NULL),
  CONSTRAINT chk_ev_range CHECK (to_kv_id IS NULL OR to_kv_id <> from_kv_id),
  -- 사례 3구분은 셋이 함께 있거나 함께 없다
  CONSTRAINT chk_ev_case_triplet CHECK (
    (case_facts IS NULL AND case_judgment IS NULL AND case_basis IS NULL) OR
    (case_facts IS NOT NULL AND case_judgment IS NOT NULL AND case_basis IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ev_item ON evidence_version (evidence_item_id);

-- P0 근거 데이터 갱신 작업 (S0 한 번의 갱신)
CREATE TABLE IF NOT EXISTS ingest_batch (
  batch_id      BIGINT      NOT NULL AUTO_INCREMENT,
  base_kv_id    INT         NULL,          -- 갱신 시작 시점의 현재 기준일. 최초 적재는 NULL(UC7 사전조건 2)
  stage         VARCHAR(20) NOT NULL,
  started_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at   TIMESTAMP   NULL,          -- 0.4 운영자 승인
  result_kv_id  INT         NULL,          -- 0.4 Output H0
  CONSTRAINT pk_ingest_batch PRIMARY KEY (batch_id),
  CONSTRAINT fk_ib_base FOREIGN KEY (base_kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT fk_ib_result FOREIGN KEY (result_kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT uq_ib_result UNIQUE (result_kv_id),
  CONSTRAINT chk_ib_stage CHECK (stage IN ('collecting','collect_failed','preprocessing','selecting',
                                           'kv_created','impact_identified','deadline_checked')),
  -- 승인과 새 기준일은 함께 생긴다 (UC7 기본흐름 4)
  CONSTRAINT chk_ib_approve CHECK ((approved_at IS NULL AND result_kv_id IS NULL) OR
                                   (approved_at IS NOT NULL AND result_kv_id IS NOT NULL)),
  -- G0: 수집 실패 상태에서는 새 기준일이 생기지 않는다
  CONSTRAINT chk_ib_g0 CHECK (stage <> 'collect_failed' OR result_kv_id IS NULL)
);

-- 기관별 수집 결과 (S0 수집 결과 표, G0 실패 기관·사유)
CREATE TABLE IF NOT EXISTS ingest_source_status (
  batch_id     BIGINT       NOT NULL,
  agency       VARCHAR(12)  NOT NULL,
  status       VARCHAR(8)   NOT NULL,
  fail_reason  VARCHAR(200) NULL,
  CONSTRAINT pk_ingest_source_status PRIMARY KEY (batch_id, agency),
  CONSTRAINT fk_iss_batch FOREIGN KEY (batch_id) REFERENCES ingest_batch (batch_id) ON DELETE CASCADE,
  CONSTRAINT chk_iss_agency CHECK (agency IN ('law_center','ftc','data_portal','kca')),
  CONSTRAINT chk_iss_status CHECK (status IN ('ok','failed')),
  CONSTRAINT chk_iss_reason CHECK ((status = 'failed' AND fail_reason IS NOT NULL) OR
                                   (status = 'ok' AND fail_reason IS NULL))
);

-- 수집 항목 (S0 반영 대상·G1 검토 목록). 운영자가 결정한 것은 include_flag 하나뿐이다.
CREATE TABLE IF NOT EXISTS ingest_item (
  item_id             BIGINT       NOT NULL AUTO_INCREMENT,
  batch_id            BIGINT       NOT NULL,
  agency              VARCHAR(12)  NOT NULL,
  item_title          VARCHAR(300) NOT NULL,
  change_kind         VARCHAR(20)  NOT NULL,
  effective_date      DATE         NULL,
  published_date      DATE         NULL,
  parse_status        VARCHAR(8)   NOT NULL,
  parse_fail_reason   VARCHAR(200) NULL,
  include_flag        BOOLEAN      NOT NULL DEFAULT FALSE,
  evidence_item_id    BIGINT       NULL,     -- 반영 시 대응 근거 항목 (폐지·개정 대상 포함)
  evidence_version_id BIGINT       NULL,     -- 반영 시 새로 생긴 근거 버전 (폐지는 NULL)
  CONSTRAINT pk_ingest_item PRIMARY KEY (item_id),
  CONSTRAINT fk_ii_batch FOREIGN KEY (batch_id) REFERENCES ingest_batch (batch_id) ON DELETE CASCADE,
  CONSTRAINT fk_ii_ei FOREIGN KEY (evidence_item_id) REFERENCES evidence_item (evidence_item_id),
  CONSTRAINT fk_ii_ev FOREIGN KEY (evidence_version_id) REFERENCES evidence_version (evidence_version_id),
  CONSTRAINT chk_ii_agency CHECK (agency IN ('law_center','ftc','data_portal','kca')),
  CONSTRAINT chk_ii_change CHECK (change_kind IN ('amend','repeal','new_law','new_case','std_terms_revision','reference')),
  CONSTRAINT chk_ii_parse CHECK ((parse_status = 'failed' AND parse_fail_reason IS NOT NULL) OR
                                 (parse_status = 'ok' AND parse_fail_reason IS NULL)),
  -- G1 · BR-KNW-02: 분리 실패 항목은 반영에 포함할 수 없다
  CONSTRAINT chk_ii_g1 CHECK (parse_status = 'ok' OR include_flag = FALSE),
  -- 소비자원 참고 자료는 근거 유형이 아니다(FR-021 출처 유형 3종) — 근거로 반영하지 않는다
  CONSTRAINT chk_ii_reference CHECK (change_kind <> 'reference' OR (evidence_item_id IS NULL AND evidence_version_id IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_ii_batch ON ingest_item (batch_id);

-- ---------------------------------------------------------------------
-- B. 분석 입력·구조화 (H1 · H2)
-- ---------------------------------------------------------------------

-- H1 분석 요청. 1.7 에서 생성된다(그 전의 G2~G5 차단은 gate_event 에만 남는다).
CREATE TABLE IF NOT EXISTS analysis_request (
  request_id    BIGINT      NOT NULL AUTO_INCREMENT,
  user_id       BIGINT      NULL,
  session_id    CHAR(36)    NULL,
  input_method  VARCHAR(4)  NOT NULL,
  perspective   VARCHAR(8)  NOT NULL,
  fixed_kv_id   INT         NOT NULL,     -- BR-ANL-05: 1.7 에서 고정한 기준일
  stage         VARCHAR(16) NOT NULL,
  requested_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_analysis_request PRIMARY KEY (request_id),
  CONSTRAINT fk_ar_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_ar_session FOREIGN KEY (session_id) REFERENCES anon_session (session_id),
  CONSTRAINT fk_ar_kv FOREIGN KEY (fixed_kv_id) REFERENCES knowledge_version (kv_id),
  -- BR-HIS-01: 로그인 사용자 또는 비로그인 세션 중 하나의 소유
  CONSTRAINT chk_ar_owner CHECK (user_id IS NOT NULL OR session_id IS NOT NULL),
  CONSTRAINT chk_ar_input CHECK (input_method IN ('file','url','text')),      -- BR-INP-01
  CONSTRAINT chk_ar_persp CHECK (perspective IN ('consumer','business')),     -- UC4
  -- P2 진행 상태(FR-024 수신→비식별화→구조화) + 유형 확인 대기 + G6 중단
  CONSTRAINT chk_ar_stage CHECK (stage IN ('received','deidentifying','structuring','awaiting_type','type_confirmed','stopped'))
);
CREATE INDEX IF NOT EXISTS ix_ar_user ON analysis_request (user_id);
CREATE INDEX IF NOT EXISTS ix_ar_session ON analysis_request (session_id);

-- 문서. 한 요청에 복수 계약이면 여러 행(UC1 A5)
CREATE TABLE IF NOT EXISTS document (
  document_id              BIGINT       NOT NULL AUTO_INCREMENT,
  request_id               BIGINT       NOT NULL,
  doc_seq                  SMALLINT     NOT NULL,
  display_name             VARCHAR(255) NOT NULL,   -- 비식별 처리한 문서명(미해결 U-5)
  file_format              VARCHAR(5)   NULL,
  source_url               VARCHAR(1000) NULL,      -- FR-004 원본 URL
  collected_at             TIMESTAMP    NULL,       -- FR-004 수집 시각
  ocr_applied              BOOLEAN      NOT NULL DEFAULT FALSE,
  is_contract              BOOLEAN      NULL,       -- 2.2 판별 결과. NULL = 아직 판별 전
  split_method             VARCHAR(8)   NULL,       -- FR-011 적용 분할 방식
  raw_file_ref             VARCHAR(500) NULL,       -- 원본 임시 보관 위치(DB 밖). 삭제 후 NULL
  raw_delete_due_at        TIMESTAMP    NULL,       -- 2.3 원본 삭제 예약 시각 (BR-PRV-02)
  raw_deleted_at           TIMESTAMP    NULL,       -- 실제 삭제 시각 (SC-014 증빙)
  summary_status           VARCHAR(12)  NULL,
  summary_text             TEXT         NULL,
  summary_model_version    VARCHAR(40)  NULL,       -- M4 model_version (BR-MDL-05)
  contract_type_candidate  VARCHAR(20)  NULL,       -- 2.5 M4 유형 후보
  contract_type            VARCHAR(20)  NULL,       -- 2.6 확정 유형 (H2)
  contract_type_confirmed_at TIMESTAMP  NULL,
  CONSTRAINT pk_document PRIMARY KEY (document_id),
  CONSTRAINT fk_doc_request FOREIGN KEY (request_id) REFERENCES analysis_request (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_doc_ct_cand FOREIGN KEY (contract_type_candidate) REFERENCES contract_type_code (contract_type),
  CONSTRAINT fk_doc_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  CONSTRAINT uq_doc_seq UNIQUE (request_id, doc_seq),
  CONSTRAINT chk_doc_format CHECK (file_format IS NULL OR file_format IN ('pdf','hwp','hwpx','docx','html')),  -- BR-INP-01
  CONSTRAINT chk_doc_url CHECK ((source_url IS NULL AND collected_at IS NULL) OR
                                (source_url IS NOT NULL AND collected_at IS NOT NULL)),                      -- FR-004
  CONSTRAINT chk_doc_split CHECK (split_method IS NULL OR split_method IN ('article','semantic')),
  -- BR-PRV-02: 원본을 지웠으면 위치 참조도 없다
  CONSTRAINT chk_doc_raw_deleted CHECK (raw_deleted_at IS NULL OR raw_file_ref IS NULL),
  CONSTRAINT chk_doc_summary CHECK (
    summary_status IS NULL OR
    (summary_status = 'ok' AND summary_text IS NOT NULL AND summary_model_version IS NOT NULL) OR
    (summary_status = 'unavailable' AND summary_text IS NULL)),                                              -- UC1 E8
  CONSTRAINT chk_doc_type_confirm CHECK ((contract_type IS NULL AND contract_type_confirmed_at IS NULL) OR
                                         (contract_type IS NOT NULL AND contract_type_confirmed_at IS NOT NULL)),
  -- BR-INP-03 · G6: 계약서가 아닌 문서는 유형을 확정하지 않는다
  CONSTRAINT chk_doc_g6 CHECK (is_contract IS NULL OR is_contract = TRUE OR contract_type IS NULL)
);

-- 조항. 비식별 원문만 저장한다(BR-PRV-01).
CREATE TABLE IF NOT EXISTS clause (
  clause_id        BIGINT      NOT NULL AUTO_INCREMENT,
  document_id      BIGINT      NOT NULL,
  seq              INT         NOT NULL,
  article_no       VARCHAR(20) NULL,
  paragraph_no     VARCHAR(20) NULL,
  item_no          VARCHAR(20) NULL,
  title            VARCHAR(200) NULL,
  deid_text        TEXT        NOT NULL,
  -- 유도 컬럼(저장): 캐시 키의 첫 필드. DB 한 곳에서만 계산한다  [DBMS] 3) SHA2
  text_hash        CHAR(64)    GENERATED ALWAYS AS (SHA2(deid_text, 256)) STORED,
  low_ocr_quality  BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT pk_clause PRIMARY KEY (clause_id),
  CONSTRAINT fk_clause_doc FOREIGN KEY (document_id) REFERENCES document (document_id) ON DELETE CASCADE,
  CONSTRAINT uq_clause_seq UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_clause_hash ON clause (text_hash);

-- ---------------------------------------------------------------------
-- C. 판정·결과 (H3)
-- ---------------------------------------------------------------------

-- 분석 실행. 최초 분석(P3 분석 모드)과 재분석(P6)이 각각 한 행. saved 가 H3 분석 결과다.
CREATE TABLE IF NOT EXISTS analysis_run (
  run_id        BIGINT      NOT NULL AUTO_INCREMENT,
  request_id    BIGINT      NOT NULL,
  run_kind      VARCHAR(10) NOT NULL,
  prev_run_id   BIGINT      NULL,          -- 재분석은 이전 결과를 참조하는 새 결과(SD_01 §9-3)
  kv_id         INT         NOT NULL,      -- H3 knowledge_date
  stage         VARCHAR(10) NOT NULL,
  job_ref       VARCHAR(64) NULL,          -- 3.1 Output 작업 ID (POST /v1/jobs)
  started_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at  TIMESTAMP   NULL,          -- 3.8 조립 완료
  saved_at      TIMESTAMP   NULL,          -- 3.9 / 6.7 "결과 보기" — 결과 저장 시점
  CONSTRAINT pk_analysis_run PRIMARY KEY (run_id),
  CONSTRAINT fk_run_request FOREIGN KEY (request_id) REFERENCES analysis_request (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_run_prev FOREIGN KEY (prev_run_id) REFERENCES analysis_run (run_id) ON DELETE CASCADE,  -- 이탈 1
  CONSTRAINT fk_run_kv FOREIGN KEY (kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT chk_run_kind CHECK (run_kind IN ('analysis','reanalysis')),
  CONSTRAINT chk_run_prev CHECK ((run_kind = 'analysis' AND prev_run_id IS NULL) OR
                                 (run_kind = 'reanalysis' AND prev_run_id IS NOT NULL)),
  -- FR-024 탐지→근거 검색→설명, 완료, 저장. aborted = G5 서버 다운으로 종료(재개 없음)
  CONSTRAINT chk_run_stage CHECK (stage IN ('detecting','searching','explaining','completed','saved','aborted')),
  CONSTRAINT chk_run_saved CHECK ((stage = 'saved' AND saved_at IS NOT NULL AND completed_at IS NOT NULL) OR
                                  (stage <> 'saved' AND saved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_run_request ON analysis_run (request_id);

-- 판정 캐시 = M3 판정. 캐시 키 5필드가 UNIQUE (BR-MDL-04 · BR-ANL-02 · SC-008)
CREATE TABLE IF NOT EXISTS judgment (
  judgment_id              BIGINT      NOT NULL AUTO_INCREMENT,
  text_hash                CHAR(64)    NOT NULL,
  contract_type            VARCHAR(20) NOT NULL,
  perspective              VARCHAR(8)  NOT NULL,
  kv_id                    INT         NOT NULL,
  m3_model_version         VARCHAR(40) NOT NULL,
  m3_category              VARCHAR(8)  NOT NULL,
  risk_type                VARCHAR(20) NULL,
  risk_level               VARCHAR(4)  NULL,
  confidence               VARCHAR(6)  NULL,
  explanation_regen_count  SMALLINT    NOT NULL DEFAULT 0,   -- UC3 E3 재생성 1회
  origin                   VARCHAR(10) NOT NULL,              -- 미해결 P-5: 평가 판정을 캐시에 넣을지
  created_at               TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_judgment PRIMARY KEY (judgment_id),
  CONSTRAINT fk_j_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  CONSTRAINT fk_j_kv FOREIGN KEY (kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT uq_judgment_cache_key UNIQUE (text_hash, contract_type, perspective, kv_id, m3_model_version),
  CONSTRAINT chk_j_persp CHECK (perspective IN ('consumer','business')),
  CONSTRAINT chk_j_cat CHECK (m3_category IN ('normal','dispute','unfair','illegal')),              -- FR-014
  CONSTRAINT chk_j_type CHECK (risk_type IS NULL OR risk_type IN
    ('rights_limit','liability_avoid','refund_cancel_limit','unilateral_change','excessive_penalty','vague','other')),
  CONSTRAINT chk_j_level CHECK (risk_level IS NULL OR risk_level IN ('high','mid','low')),
  CONSTRAINT chk_j_conf CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  -- BR-ANL-01: 정상이 아니면 위험 유형·위험도·신뢰도가 모두 있고, 정상이면 모두 없다
  CONSTRAINT chk_j_br_anl_01 CHECK (
    (m3_category = 'normal' AND risk_type IS NULL AND risk_level IS NULL AND confidence IS NULL) OR
    (m3_category <> 'normal' AND risk_type IS NOT NULL AND risk_level IS NOT NULL AND confidence IS NOT NULL)),
  CONSTRAINT chk_j_regen CHECK (explanation_regen_count BETWEEN 0 AND 1),
  CONSTRAINT chk_j_origin CHECK (origin IN ('service','evaluation'))
);

-- 판정–근거 연결 (4.6 근거 목록)
CREATE TABLE IF NOT EXISTS judgment_evidence (
  judgment_id         BIGINT   NOT NULL,
  evidence_version_id BIGINT   NOT NULL,
  display_rank        SMALLINT NOT NULL,
  CONSTRAINT pk_judgment_evidence PRIMARY KEY (judgment_id, evidence_version_id),
  CONSTRAINT fk_je_j FOREIGN KEY (judgment_id) REFERENCES judgment (judgment_id) ON DELETE CASCADE,
  CONSTRAINT fk_je_ev FOREIGN KEY (evidence_version_id) REFERENCES evidence_version (evidence_version_id)
);

-- 쉬운 설명의 주장. 각 주장은 그 판정의 근거 중 하나에 연결된다(BR-EXP-04) — 복합 FK 로 강제
CREATE TABLE IF NOT EXISTS explanation_claim (
  judgment_id         BIGINT   NOT NULL,
  seq                 SMALLINT NOT NULL,
  claim_text          TEXT     NOT NULL,
  evidence_version_id BIGINT   NOT NULL,
  CONSTRAINT pk_explanation_claim PRIMARY KEY (judgment_id, seq),
  CONSTRAINT fk_ec_je FOREIGN KEY (judgment_id, evidence_version_id)
    REFERENCES judgment_evidence (judgment_id, evidence_version_id) ON DELETE CASCADE
);

-- 조항 판정 = 실행 × 조항. 탐지 점수와 판정 참조
CREATE TABLE IF NOT EXISTS clause_assessment (
  assessment_id        BIGINT       NOT NULL AUTO_INCREMENT,
  run_id               BIGINT       NOT NULL,
  clause_id            BIGINT       NOT NULL,
  score_loophole       DECIMAL(5,4) NULL,       -- M1 편법 점수
  score_illegal        DECIMAL(5,4) NULL,       -- M2 위법 점수
  m1_model_version     VARCHAR(40)  NULL,
  m2_model_version     VARCHAR(40)  NULL,
  screen_result        VARCHAR(16)  NULL,       -- 3.3 선별 결과(유도인데 저장 — 기준치 변경에도 고정)
  judgment_id          BIGINT       NULL,
  status               VARCHAR(12)  NOT NULL,
  unanalyzable_reason  VARCHAR(12)  NULL,
  rejudged_at          TIMESTAMP    NULL,       -- 4.5 분석 불가 조항 다시 분석(미해결 P-7)
  CONSTRAINT pk_clause_assessment PRIMARY KEY (assessment_id),
  CONSTRAINT fk_ca_run FOREIGN KEY (run_id) REFERENCES analysis_run (run_id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_clause FOREIGN KEY (clause_id) REFERENCES clause (clause_id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_j FOREIGN KEY (judgment_id) REFERENCES judgment (judgment_id),
  CONSTRAINT uq_ca_run_clause UNIQUE (run_id, clause_id),
  CONSTRAINT chk_ca_screen CHECK (screen_result IS NULL OR screen_result IN ('normal_candidate','risk_candidate')),
  CONSTRAINT chk_ca_status CHECK (status IN ('pending','normal','judged','unanalyzable')),
  CONSTRAINT chk_ca_reason CHECK (unanalyzable_reason IS NULL OR unanalyzable_reason IN ('timeout','server_down')),
  -- BR-ANL-04 · BR-MDL-06: 상태별 필수 조합
  CONSTRAINT chk_ca_state CHECK (
    (status = 'pending'      AND judgment_id IS NULL     AND unanalyzable_reason IS NULL) OR
    (status = 'normal'       AND judgment_id IS NULL     AND unanalyzable_reason IS NULL AND screen_result = 'normal_candidate') OR
    (status = 'judged'       AND judgment_id IS NOT NULL AND unanalyzable_reason IS NULL AND screen_result = 'risk_candidate') OR
    (status = 'unanalyzable' AND judgment_id IS NULL     AND unanalyzable_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ca_judgment ON clause_assessment (judgment_id);

-- ---------------------------------------------------------------------
-- A. 이용 한도 원장
-- ---------------------------------------------------------------------

-- 사용량 차감 원장. 결과를 지워도 차감 기록은 남는다(run_id 만 NULL) — 삭제로 한도를 되찾지 못하게
CREATE TABLE IF NOT EXISTS usage_charge (
  charge_id    BIGINT    NOT NULL AUTO_INCREMENT,
  user_id      BIGINT    NULL,
  session_id   CHAR(36)  NULL,
  run_id       BIGINT    NULL,
  charged_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- 유도 컬럼(저장): 한도 집계 월. 생성 컬럼 한 곳에서만 계산 (달력 월 기준 [추론] — 미해결 D-3)
  usage_month  INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM charged_at) * 100 + EXTRACT(MONTH FROM charged_at)) STORED,
  CONSTRAINT pk_usage_charge PRIMARY KEY (charge_id),
  CONSTRAINT fk_uc_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_uc_session FOREIGN KEY (session_id) REFERENCES anon_session (session_id),
  CONSTRAINT fk_uc_run FOREIGN KEY (run_id) REFERENCES analysis_run (run_id) ON DELETE SET NULL,
  CONSTRAINT uq_uc_run UNIQUE (run_id),                       -- 한 결과에 한 번만 차감
  CONSTRAINT chk_uc_owner CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)   -- BR-INP-04
);
CREATE INDEX IF NOT EXISTS ix_uc_user_month ON usage_charge (user_id, usage_month);
CREATE INDEX IF NOT EXISTS ix_uc_session_month ON usage_charge (session_id, usage_month);

-- ---------------------------------------------------------------------
-- D. 영향 결과 (H0b)
-- ---------------------------------------------------------------------

-- 0.5 에서 식별한 영향 결과. "관련 신규 사례"(UC7 A1)는 링크로 유도할 수 없어 저장한다.
CREATE TABLE IF NOT EXISTS result_impact (
  impact_id        BIGINT      NOT NULL AUTO_INCREMENT,
  run_id           BIGINT      NOT NULL,
  kv_id            INT         NOT NULL,     -- 영향을 일으킨 새 기준일
  evidence_item_id BIGINT      NOT NULL,
  change_kind      VARCHAR(20) NOT NULL,
  identified_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_result_impact PRIMARY KEY (impact_id),
  CONSTRAINT fk_ri_run FOREIGN KEY (run_id) REFERENCES analysis_run (run_id) ON DELETE CASCADE,
  CONSTRAINT fk_ri_kv FOREIGN KEY (kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT fk_ri_ei FOREIGN KEY (evidence_item_id) REFERENCES evidence_item (evidence_item_id),
  CONSTRAINT uq_ri UNIQUE (run_id, kv_id, evidence_item_id),
  CONSTRAINT chk_ri_change CHECK (change_kind IN ('amend','repeal','new_case','std_terms_revision'))
);

-- ---------------------------------------------------------------------
-- E. 피드백·보안 사고
-- ---------------------------------------------------------------------

-- H4 피드백. 대상 조항·판정·기준일 연결(BR-FDB-01) — 결과가 삭제돼도 기준일·당시 판정은 남는다
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id        BIGINT      NOT NULL AUTO_INCREMENT,
  assessment_id      BIGINT      NULL,      -- 대상 조항(결과 삭제 시 NULL → UC9 E1 대상 표시 불가)
  judgment_id        BIGINT      NULL,      -- 대상 판정(정상·분석 불가 조항은 판정 행이 없다)
  kv_id              INT         NOT NULL,  -- 대상 지식 기준일
  category_at_submit VARCHAR(12) NOT NULL,  -- 제출 시점 표시 판정(유도인데 저장 — 4.5 재판정에도 고정)
  feedback_type      VARCHAR(16) NOT NULL,
  opinion_deid       TEXT        NULL,      -- 5.3 비식별 의견. 선택 입력(UC6 A2)
  user_id            BIGINT      NULL,
  session_id         CHAR(36)    NULL,
  submitted_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  review_status      VARCHAR(10) NOT NULL DEFAULT 'unreviewed',
  review_decision    VARCHAR(12) NULL,
  CONSTRAINT pk_feedback PRIMARY KEY (feedback_id),
  CONSTRAINT fk_fb_ca FOREIGN KEY (assessment_id) REFERENCES clause_assessment (assessment_id) ON DELETE SET NULL,
  CONSTRAINT fk_fb_j FOREIGN KEY (judgment_id) REFERENCES judgment (judgment_id),
  CONSTRAINT fk_fb_kv FOREIGN KEY (kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT fk_fb_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_fb_session FOREIGN KEY (session_id) REFERENCES anon_session (session_id),
  CONSTRAINT chk_fb_cat CHECK (category_at_submit IN ('normal','dispute','unfair','illegal','unanalyzable')),
  CONSTRAINT chk_fb_type CHECK (feedback_type IN ('false_positive','false_negative')),
  -- 5.2: 위험 판정에는 오탐만, 정상·분석 불가에는 미탐만
  CONSTRAINT chk_fb_type_by_cat CHECK (
    (feedback_type = 'false_positive' AND category_at_submit IN ('dispute','unfair','illegal')) OR
    (feedback_type = 'false_negative' AND category_at_submit IN ('normal','unanalyzable'))),
  CONSTRAINT chk_fb_owner CHECK (user_id IS NOT NULL OR session_id IS NOT NULL),
  CONSTRAINT chk_fb_status CHECK (review_status IN ('unreviewed','reviewed')),
  CONSTRAINT chk_fb_decision CHECK (review_decision IS NULL OR review_decision IN ('valid','invalid','needs_expert')),
  -- 8.4: 검토 완료이면 판단이 있고, 미검토이면 없다
  CONSTRAINT chk_fb_review CHECK ((review_status = 'unreviewed' AND review_decision IS NULL) OR
                                  (review_status = 'reviewed' AND review_decision IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_fb_kv_status ON feedback (kv_id, review_status);

-- G13 보안 사고 기록. 발견된 민감정보 원문은 저장하지 않는다(유형만) — BR-PRV-04
CREATE TABLE IF NOT EXISTS security_incident (
  incident_id    BIGINT      NOT NULL AUTO_INCREMENT,
  feedback_id    BIGINT      NULL,
  detected_field VARCHAR(8)  NOT NULL,
  pii_type       VARCHAR(20) NOT NULL,
  detected_at    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  masked_at      TIMESTAMP   NULL,
  CONSTRAINT pk_security_incident PRIMARY KEY (incident_id),
  CONSTRAINT fk_si_fb FOREIGN KEY (feedback_id) REFERENCES feedback (feedback_id) ON DELETE SET NULL,
  CONSTRAINT chk_si_field CHECK (detected_field IN ('opinion','clause')),
  CONSTRAINT chk_si_pii CHECK (pii_type IN ('rrn','foreigner_no','account_no','card_no','phone','email','address','person_name'))  -- FR-006 8종
);

-- H5 평가 데이터 후보. 조항은 비식별 원문 스냅샷(유도인데 저장 — 결과 삭제와 무관하게 평가 재현)
CREATE TABLE IF NOT EXISTS eval_candidate (
  candidate_id     BIGINT      NOT NULL AUTO_INCREMENT,
  feedback_id      BIGINT      NULL,
  clause_text_deid TEXT        NOT NULL,
  contract_type    VARCHAR(20) NOT NULL,
  candidate_at     TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_eval_candidate PRIMARY KEY (candidate_id),
  CONSTRAINT fk_ecand_fb FOREIGN KEY (feedback_id) REFERENCES feedback (feedback_id) ON DELETE SET NULL,
  CONSTRAINT fk_ecand_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  CONSTRAINT uq_ecand_fb UNIQUE (feedback_id)
);

-- ---------------------------------------------------------------------
-- F. 품질 평가
-- ---------------------------------------------------------------------

-- 평가 데이터 (spec Key Entities `평가 데이터`)
CREATE TABLE IF NOT EXISTS eval_item (
  eval_item_id      BIGINT      NOT NULL AUTO_INCREMENT,
  clause_text_deid  TEXT        NOT NULL,
  contract_type     VARCHAR(20) NOT NULL,
  gold_category     VARCHAR(8)  NOT NULL,
  origin            VARCHAR(20) NOT NULL,
  candidate_id      BIGINT      NULL,
  overlaps_training BOOLEAN     NOT NULL DEFAULT FALSE,
  review_status     VARCHAR(10) NOT NULL DEFAULT 'pending',
  reviewer_user_id  BIGINT      NULL,
  reviewed_at       TIMESTAMP   NULL,
  CONSTRAINT pk_eval_item PRIMARY KEY (eval_item_id),
  CONSTRAINT fk_ei_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  CONSTRAINT fk_eitem_cand FOREIGN KEY (candidate_id) REFERENCES eval_candidate (candidate_id),
  CONSTRAINT fk_eitem_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES app_user (user_id),
  CONSTRAINT uq_eitem_cand UNIQUE (candidate_id),
  CONSTRAINT chk_eitem_gold CHECK (gold_category IN ('normal','dispute','unfair','illegal')),          -- FR-042 4범주
  CONSTRAINT chk_eitem_origin CHECK (origin IN ('new_label','feedback_candidate','synthetic')),
  CONSTRAINT chk_eitem_origin_cand CHECK ((origin = 'feedback_candidate' AND candidate_id IS NOT NULL) OR
                                          (origin <> 'feedback_candidate' AND candidate_id IS NULL)),
  CONSTRAINT chk_eitem_status CHECK (review_status IN ('pending','accepted','rejected')),
  -- BR-QA-01: 검수 결과에는 검수자·검수일이 있다
  CONSTRAINT chk_eitem_reviewed CHECK (review_status = 'pending' OR
                                       (reviewer_user_id IS NOT NULL AND reviewed_at IS NOT NULL)),
  -- BR-QA-01 · G10(해제 불가 부분): 인위적 변형·학습 데이터 중복 조항은 채택할 수 없다
  CONSTRAINT chk_eitem_br_qa_01 CHECK (review_status <> 'accepted' OR (origin <> 'synthetic' AND overlaps_training = FALSE))
);

-- 평가 데이터의 정답 근거 (Key Entities "정답 근거")
CREATE TABLE IF NOT EXISTS eval_item_gold_evidence (
  eval_item_id     BIGINT NOT NULL,
  evidence_item_id BIGINT NOT NULL,
  CONSTRAINT pk_eval_item_gold_evidence PRIMARY KEY (eval_item_id, evidence_item_id),
  CONSTRAINT fk_eige_item FOREIGN KEY (eval_item_id) REFERENCES eval_item (eval_item_id) ON DELETE CASCADE,
  CONSTRAINT fk_eige_ev FOREIGN KEY (evidence_item_id) REFERENCES evidence_item (evidence_item_id)
);

-- 평가 실행 (S7-O 한 번의 평가, H6 의 머리)
CREATE TABLE IF NOT EXISTS eval_run (
  eval_run_id       BIGINT      NOT NULL AUTO_INCREMENT,
  kv_id             INT         NOT NULL,
  m1_model_version  VARCHAR(40) NOT NULL,
  m2_model_version  VARCHAR(40) NOT NULL,
  m3_model_version  VARCHAR(40) NOT NULL,
  stage             VARCHAR(16) NOT NULL,
  started_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sc_confirmed_at   TIMESTAMP   NULL,     -- "성공 기준 확정"(SD_02 U-4)
  recorded_at       TIMESTAMP   NULL,     -- 7.9 평가 기록 (H6)
  CONSTRAINT pk_eval_run PRIMARY KEY (eval_run_id),
  CONSTRAINT fk_er_kv FOREIGN KEY (kv_id) REFERENCES knowledge_version (kv_id),
  CONSTRAINT chk_er_stage CHECK (stage IN ('eligibility','inferring','awaiting_expert','result','recorded','aborted')),
  -- UC8 E6: 서버 다운으로 중단된 평가는 기록하지 않는다
  CONSTRAINT chk_er_aborted CHECK (stage <> 'aborted' OR recorded_at IS NULL),
  CONSTRAINT chk_er_recorded CHECK ((stage = 'recorded' AND recorded_at IS NOT NULL) OR
                                    (stage <> 'recorded' AND recorded_at IS NULL))
);

-- 평가 실행 × 평가 데이터. 적격성·예측은 실행 시점 값으로 고정(유도인데 저장)
CREATE TABLE IF NOT EXISTS eval_run_item (
  eval_run_id        BIGINT      NOT NULL,
  eval_item_id       BIGINT      NOT NULL,
  eligibility        VARCHAR(28) NOT NULL,
  predicted_category VARCHAR(8)  NULL,
  timed_out          BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT pk_eval_run_item PRIMARY KEY (eval_run_id, eval_item_id),
  CONSTRAINT fk_eri_run FOREIGN KEY (eval_run_id) REFERENCES eval_run (eval_run_id) ON DELETE CASCADE,
  CONSTRAINT fk_eri_item FOREIGN KEY (eval_item_id) REFERENCES eval_item (eval_item_id),
  -- G10: 제외 사유 3종
  CONSTRAINT chk_eri_elig CHECK (eligibility IN ('included','excluded_unreviewed','excluded_synthetic','excluded_training_overlap')),
  CONSTRAINT chk_eri_pred CHECK (predicted_category IS NULL OR predicted_category IN ('normal','dispute','unfair','illegal')),
  CONSTRAINT chk_eri_excluded CHECK (eligibility = 'included' OR (predicted_category IS NULL AND timed_out = FALSE)),
  -- UC8 E6: 타임아웃 조항은 예측이 없다(지표에서 제외)
  CONSTRAINT chk_eri_timeout CHECK (timed_out = FALSE OR predicted_category IS NULL)
);

-- 근거 적합성 표본 판정 (7.7, G11)
CREATE TABLE IF NOT EXISTS eval_evidence_review (
  eval_run_id         BIGINT      NOT NULL,
  eval_item_id        BIGINT      NOT NULL,
  evidence_version_id BIGINT      NOT NULL,
  requested_at        TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  verdict             VARCHAR(10) NULL,
  reviewer_user_id    BIGINT      NULL,
  responded_at        TIMESTAMP   NULL,
  CONSTRAINT pk_eval_evidence_review PRIMARY KEY (eval_run_id, eval_item_id, evidence_version_id),
  CONSTRAINT fk_eer_eri FOREIGN KEY (eval_run_id, eval_item_id) REFERENCES eval_run_item (eval_run_id, eval_item_id) ON DELETE CASCADE,
  CONSTRAINT fk_eer_ev FOREIGN KEY (evidence_version_id) REFERENCES evidence_version (evidence_version_id),
  CONSTRAINT fk_eer_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES app_user (user_id),
  CONSTRAINT chk_eer_verdict CHECK (verdict IS NULL OR verdict IN ('relevant','irrelevant')),
  CONSTRAINT chk_eer_reply CHECK ((verdict IS NULL AND responded_at IS NULL AND reviewer_user_id IS NULL) OR
                                  (verdict IS NOT NULL AND responded_at IS NOT NULL AND reviewer_user_id IS NOT NULL))
);

-- H6 평가 기록의 계약 유형별 지표. 7.9 기록 시점에 v_eval_metric_live 값을 고정 저장(유도인데 저장)
CREATE TABLE IF NOT EXISTS eval_metric (
  eval_run_id        BIGINT       NOT NULL,
  contract_type      VARCHAR(20)  NOT NULL,
  clause_count       INT          NOT NULL,
  timeout_excluded   INT          NOT NULL,
  recall_pct         DECIMAL(5,2) NULL,
  precision_pct      DECIMAL(5,2) NULL,
  evidence_fit_pct   DECIMAL(5,2) NULL,     -- NULL = 판정 대기(G11) 또는 측정 불가
  measurable         BOOLEAN      NOT NULL,
  CONSTRAINT pk_eval_metric PRIMARY KEY (eval_run_id, contract_type),
  CONSTRAINT fk_em_run FOREIGN KEY (eval_run_id) REFERENCES eval_run (eval_run_id) ON DELETE CASCADE,
  CONSTRAINT fk_em_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  -- G12: 측정 불가 유형은 지표를 내지 않는다
  CONSTRAINT chk_em_g12 CHECK (measurable = TRUE OR (recall_pct IS NULL AND precision_pct IS NULL AND evidence_fit_pct IS NULL)),
  CONSTRAINT chk_em_range CHECK ((recall_pct IS NULL OR recall_pct BETWEEN 0 AND 100) AND
                                 (precision_pct IS NULL OR precision_pct BETWEEN 0 AND 100) AND
                                 (evidence_fit_pct IS NULL OR evidence_fit_pct BETWEEN 0 AND 100))
);

-- ---------------------------------------------------------------------
-- G. 게이트 이벤트 (1급 엔티티 — 발생·해제 이력)
-- ---------------------------------------------------------------------

-- 대상 참조는 다형 참조 대신 "배타 호(exclusive arc)" — 대상 종류별 nullable FK. 게이트별 필수 대상은 CHECK 로 강제
CREATE TABLE IF NOT EXISTS gate_event (
  event_id        BIGINT       NOT NULL AUTO_INCREMENT,
  gate_code       VARCHAR(3)   NOT NULL,
  occurred_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason_code     VARCHAR(40)  NOT NULL,     -- 사유 코드(개인정보 금지 — BR-PRV-04)
  reason_detail   VARCHAR(300) NULL,
  released_at     TIMESTAMP    NULL,
  release_action  VARCHAR(40)  NULL,
  user_id         BIGINT       NULL,
  session_id      CHAR(36)     NULL,
  request_id      BIGINT       NULL,
  run_id          BIGINT       NULL,
  assessment_id   BIGINT       NULL,
  judgment_id     BIGINT       NULL,
  batch_id        BIGINT       NULL,
  ingest_item_id  BIGINT       NULL,
  eval_run_id     BIGINT       NULL,
  eval_item_id    BIGINT       NULL,
  contract_type   VARCHAR(20)  NULL,
  feedback_id     BIGINT       NULL,
  CONSTRAINT pk_gate_event PRIMARY KEY (event_id),
  CONSTRAINT fk_ge_gate FOREIGN KEY (gate_code) REFERENCES gate_def (gate_code),
  CONSTRAINT fk_ge_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_ge_session FOREIGN KEY (session_id) REFERENCES anon_session (session_id),
  CONSTRAINT fk_ge_request FOREIGN KEY (request_id) REFERENCES analysis_request (request_id) ON DELETE CASCADE,
  CONSTRAINT fk_ge_run FOREIGN KEY (run_id) REFERENCES analysis_run (run_id) ON DELETE CASCADE,
  CONSTRAINT fk_ge_ca FOREIGN KEY (assessment_id) REFERENCES clause_assessment (assessment_id) ON DELETE CASCADE,
  CONSTRAINT fk_ge_j FOREIGN KEY (judgment_id) REFERENCES judgment (judgment_id),
  CONSTRAINT fk_ge_batch FOREIGN KEY (batch_id) REFERENCES ingest_batch (batch_id),
  CONSTRAINT fk_ge_ii FOREIGN KEY (ingest_item_id) REFERENCES ingest_item (item_id),
  CONSTRAINT fk_ge_er FOREIGN KEY (eval_run_id) REFERENCES eval_run (eval_run_id),
  CONSTRAINT fk_ge_ei FOREIGN KEY (eval_item_id) REFERENCES eval_item (eval_item_id),
  CONSTRAINT fk_ge_ct FOREIGN KEY (contract_type) REFERENCES contract_type_code (contract_type),
  CONSTRAINT fk_ge_fb FOREIGN KEY (feedback_id) REFERENCES feedback (feedback_id) ON DELETE CASCADE,
  CONSTRAINT chk_ge_release CHECK ((released_at IS NULL AND release_action IS NULL) OR
                                   (released_at IS NOT NULL AND release_action IS NOT NULL)),
  -- 게이트별 필수 대상 (SD_01 §14-1 위치)
  CONSTRAINT chk_ge_subject CHECK (
    (gate_code = 'G0'  AND batch_id IS NOT NULL) OR
    (gate_code = 'G1'  AND ingest_item_id IS NOT NULL) OR
    (gate_code IN ('G2','G3','G4','G8','G14') AND (user_id IS NOT NULL OR session_id IS NOT NULL)) OR
    (gate_code = 'G5'  AND (request_id IS NOT NULL OR run_id IS NOT NULL OR assessment_id IS NOT NULL OR
                            eval_run_id IS NOT NULL OR user_id IS NOT NULL OR session_id IS NOT NULL)) OR
    (gate_code = 'G6'  AND request_id IS NOT NULL) OR
    (gate_code = 'G7'  AND run_id IS NOT NULL) OR
    (gate_code = 'G9'  AND judgment_id IS NOT NULL) OR
    (gate_code = 'G10' AND eval_run_id IS NOT NULL AND eval_item_id IS NOT NULL) OR
    (gate_code = 'G11' AND eval_run_id IS NOT NULL) OR
    (gate_code = 'G12' AND eval_run_id IS NOT NULL AND contract_type IS NOT NULL) OR
    (gate_code = 'G13' AND feedback_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_ge_open ON gate_event (gate_code, released_at);

-- =====================================================================
-- 뷰 — 유도 속성과 게이트 판정의 단일 지점
-- =====================================================================

-- [유도] 근거의 기준일별 유효 집합 (H0 "시행 중 근거 집합", BR-EVD-03). 판정 지점: 여기 한 곳
CREATE OR REPLACE VIEW v_evidence_in_force AS
SELECT kv.kv_id, ev.evidence_version_id, ev.evidence_item_id, ei.source_type, ei.source_name, ei.identifier,
       ev.excerpt, ev.source_url, ev.effective_date, ev.published_date
FROM knowledge_version kv
JOIN evidence_version ev ON 1 = 1
JOIN knowledge_version f ON f.kv_id = ev.from_kv_id
LEFT JOIN knowledge_version t ON t.kv_id = ev.to_kv_id
JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id
WHERE f.kv_seq <= kv.kv_seq
  AND (t.kv_id IS NULL OR kv.kv_seq < t.kv_seq)
  AND (ev.effective_date IS NULL OR ev.effective_date <= kv.knowledge_date);   -- 시행 전 조문 제외(UC7 A4)

-- [유도] 조항 판정의 화면 표시값 (C5 판정 배지). 강등·근거 미확인·전문가 검토 권장·설명 가능 여부의 단일 지점
CREATE OR REPLACE VIEW v_assessment_display AS
SELECT a.assessment_id, a.run_id, a.clause_id, a.status, a.judgment_id,
       j.risk_type, j.risk_level, j.confidence,
       COALESCE(e.evidence_count, 0) AS evidence_count,
       CASE
         WHEN a.status = 'unanalyzable' THEN 'unanalyzable'
         WHEN a.status = 'normal'       THEN 'normal'
         WHEN a.status = 'pending'      THEN NULL
         WHEN j.m3_category IN ('unfair','illegal') AND COALESCE(e.evidence_count, 0) = 0 THEN 'dispute'   -- BR-EVD-01 강등
         ELSE j.m3_category
       END AS display_category,
       CASE WHEN a.status = 'judged' AND j.m3_category <> 'normal' AND COALESCE(e.evidence_count, 0) = 0
            THEN TRUE ELSE FALSE END AS evidence_unconfirmed,                                              -- UC2 A2
       CASE WHEN j.confidence = 'low' OR ct.in_scope = FALSE THEN TRUE ELSE FALSE END AS expert_review_recommended,  -- BR-EXP-03
       CASE WHEN a.judgment_id IS NULL THEN NULL
            WHEN EXISTS (SELECT 1 FROM gate_event g WHERE g.gate_code = 'G9' AND g.judgment_id = a.judgment_id
                         AND g.released_at IS NULL) THEN FALSE
            ELSE TRUE END AS explanation_available,                                                        -- G9
       c.low_ocr_quality
FROM clause_assessment a
JOIN clause c ON c.clause_id = a.clause_id
JOIN document d ON d.document_id = c.document_id
LEFT JOIN contract_type_code ct ON ct.contract_type = d.contract_type
LEFT JOIN judgment j ON j.judgment_id = a.judgment_id
LEFT JOIN (SELECT judgment_id, COUNT(*) AS evidence_count FROM judgment_evidence GROUP BY judgment_id) e
       ON e.judgment_id = a.judgment_id;

-- [유도] 결과별 위험도 개수 (S4 위험도별 개수, S6 위험도 요약)
CREATE OR REPLACE VIEW v_run_risk_counts AS
SELECT r.run_id,
       SUM(CASE WHEN v.display_category IN ('dispute','unfair','illegal') AND v.risk_level = 'high' THEN 1 ELSE 0 END) AS high_cnt,
       SUM(CASE WHEN v.display_category IN ('dispute','unfair','illegal') AND v.risk_level = 'mid'  THEN 1 ELSE 0 END) AS mid_cnt,
       SUM(CASE WHEN v.display_category IN ('dispute','unfair','illegal') AND v.risk_level = 'low'  THEN 1 ELSE 0 END) AS low_cnt,
       SUM(CASE WHEN v.display_category = 'unanalyzable' THEN 1 ELSE 0 END) AS unanalyzable_cnt
FROM analysis_run r
LEFT JOIN v_assessment_display v ON v.run_id = r.run_id
GROUP BY r.run_id;

-- [유도] 탐지 진행 (S3 "조항 N개 중 M개 점수 수신")
CREATE OR REPLACE VIEW v_run_progress AS
SELECT r.run_id,
       (SELECT COUNT(*) FROM clause c JOIN document d ON d.document_id = c.document_id
         WHERE d.request_id = r.request_id) AS clause_total,
       (SELECT COUNT(*) FROM clause_assessment a WHERE a.run_id = r.run_id AND a.score_loophole IS NOT NULL
         AND a.score_illegal IS NOT NULL) AS scored_cnt
FROM analysis_run r;

-- [유도 · G4 판정 지점] 이번 달 사용량과 남은 한도 (C10). 비로그인은 기기 키로 묶는다(BR-INP-04)
CREATE OR REPLACE VIEW v_quota_current AS
SELECT q.user_id, q.device_key, q.used_cnt,
       CAST((SELECT value_num FROM policy_constant WHERE const_key = 'FREE_MONTHLY_LIMIT') - q.used_cnt AS INTEGER) AS remaining   -- 이탈 2
FROM (
  SELECT uc.user_id, CASE WHEN uc.user_id IS NULL THEN s.device_key END AS device_key, COUNT(*) AS used_cnt
  FROM usage_charge uc
  LEFT JOIN anon_session s ON s.session_id = uc.session_id
  WHERE uc.usage_month = EXTRACT(YEAR FROM CURRENT_DATE) * 100 + EXTRACT(MONTH FROM CURRENT_DATE)
  GROUP BY uc.user_id, CASE WHEN uc.user_id IS NULL THEN s.device_key END
) q;

-- [유도] H0 변경 내역 — 반영된 수집 항목에서 유도 (저장하지 않는다)
CREATE OR REPLACE VIEW v_kv_changes AS
SELECT b.result_kv_id AS kv_id, i.item_id, i.agency, i.item_title, i.change_kind,
       i.effective_date, i.published_date, i.evidence_item_id, i.evidence_version_id
FROM ingest_item i
JOIN ingest_batch b ON b.batch_id = i.batch_id
WHERE b.result_kv_id IS NOT NULL AND i.include_flag = TRUE;

-- [유도] S0 반영 대상 판정 라벨·반영 경과일 (0.3 · 0.6)  [DBMS] 3) DATEDIFF
CREATE OR REPLACE VIEW v_ingest_item_status AS
SELECT i.item_id, i.batch_id, i.item_title, i.change_kind, i.include_flag,
       CASE
         WHEN i.parse_status = 'failed' THEN 'excluded_parse_fail'                  -- G1
         WHEN i.change_kind = 'repeal' THEN 'excluded_repealed'                     -- UC7 A3
         WHEN i.effective_date IS NOT NULL AND i.effective_date > CURRENT_DATE THEN 'hold_not_effective'   -- UC7 A4
         WHEN i.change_kind = 'reference' THEN 'reference_only'
         ELSE 'candidate'
       END AS decision_label,
       DATEDIFF(CURRENT_DATE, COALESCE(i.published_date, i.effective_date)) AS elapsed_days,   -- 0.6 반영 경과일
       (SELECT value_num FROM policy_constant WHERE const_key = 'KNW_REFLECT_DAYS') AS reflect_limit_days
FROM ingest_item i;

-- [유도 · H0b 유효 판정] 아직 해소되지 않은 영향 결과 — 새 결과가 저장되면 빠진다(SD_01 §13-1)
CREATE OR REPLACE VIEW v_result_impact_active AS
SELECT ri.*
FROM result_impact ri
WHERE NOT EXISTS (SELECT 1 FROM analysis_run n WHERE n.prev_run_id = ri.run_id AND n.stage = 'saved');

-- [G7 판정 지점] 같은 캐시 키에서 관점만 다른 두 판정이 분류·위험도·근거에서 어긋나는 쌍 (BR-ANL-03)
CREATE OR REPLACE VIEW v_perspective_mismatch AS
SELECT jc.judgment_id AS consumer_judgment_id, jb.judgment_id AS business_judgment_id
FROM judgment jc
JOIN judgment jb ON jb.text_hash = jc.text_hash AND jb.contract_type = jc.contract_type
                AND jb.kv_id = jc.kv_id AND jb.m3_model_version = jc.m3_model_version
WHERE jc.perspective = 'consumer' AND jb.perspective = 'business'
  AND (jc.m3_category <> jb.m3_category
       OR COALESCE(jc.risk_level, '-') <> COALESCE(jb.risk_level, '-')
       OR EXISTS (SELECT 1 FROM judgment_evidence x WHERE x.judgment_id = jc.judgment_id
                  AND NOT EXISTS (SELECT 1 FROM judgment_evidence y WHERE y.judgment_id = jb.judgment_id
                                  AND y.evidence_version_id = x.evidence_version_id))
       OR EXISTS (SELECT 1 FROM judgment_evidence y WHERE y.judgment_id = jb.judgment_id
                  AND NOT EXISTS (SELECT 1 FROM judgment_evidence x WHERE x.judgment_id = jc.judgment_id
                                  AND x.evidence_version_id = y.evidence_version_id)));

-- [유도] 평가 지표(기록 전 계산) — 재현율 SC-001 · 정밀도 SC-002 · 근거 적합률 SC-004 · 측정 가능 G12
CREATE OR REPLACE VIEW v_eval_metric_live AS
SELECT m.eval_run_id, m.contract_type, m.clause_count, m.timeout_excluded,
       CASE WHEN m.gold_risk = 0 THEN NULL ELSE ROUND(100.0 * m.hit / m.gold_risk, 2) END AS recall_pct,
       CASE WHEN m.pred_risk = 0 THEN NULL ELSE ROUND(100.0 * m.correct / m.pred_risk, 2) END AS precision_pct,
       CASE WHEN m.review_total = 0 OR m.review_pending > 0 THEN NULL
            ELSE ROUND(100.0 * m.review_relevant / m.review_total, 2) END AS evidence_fit_pct,
       m.review_pending,
       CASE WHEN mc.value_num IS NULL THEN NULL
            WHEN m.clause_count >= mc.value_num THEN TRUE ELSE FALSE END AS measurable
FROM (
  SELECT ri.eval_run_id, it.contract_type,
         SUM(CASE WHEN ri.eligibility = 'included' AND ri.predicted_category IS NOT NULL THEN 1 ELSE 0 END) AS clause_count,
         SUM(CASE WHEN ri.timed_out THEN 1 ELSE 0 END) AS timeout_excluded,
         SUM(CASE WHEN ri.predicted_category IS NOT NULL AND it.gold_category IN ('unfair','illegal') THEN 1 ELSE 0 END) AS gold_risk,
         SUM(CASE WHEN ri.predicted_category IS NOT NULL AND it.gold_category IN ('unfair','illegal')
                   AND ri.predicted_category <> 'normal' THEN 1 ELSE 0 END) AS hit,
         SUM(CASE WHEN ri.predicted_category IN ('unfair','illegal') THEN 1 ELSE 0 END) AS pred_risk,
         SUM(CASE WHEN ri.predicted_category IN ('unfair','illegal') AND it.gold_category <> 'normal' THEN 1 ELSE 0 END) AS correct,
         (SELECT COUNT(*) FROM eval_evidence_review r JOIN eval_item i2 ON i2.eval_item_id = r.eval_item_id
           WHERE r.eval_run_id = ri.eval_run_id AND i2.contract_type = it.contract_type) AS review_total,
         (SELECT COUNT(*) FROM eval_evidence_review r JOIN eval_item i2 ON i2.eval_item_id = r.eval_item_id
           WHERE r.eval_run_id = ri.eval_run_id AND i2.contract_type = it.contract_type AND r.verdict IS NULL) AS review_pending,
         (SELECT COUNT(*) FROM eval_evidence_review r JOIN eval_item i2 ON i2.eval_item_id = r.eval_item_id
           WHERE r.eval_run_id = ri.eval_run_id AND i2.contract_type = it.contract_type AND r.verdict = 'relevant') AS review_relevant
  FROM eval_run_item ri
  JOIN eval_item it ON it.eval_item_id = ri.eval_item_id
  GROUP BY ri.eval_run_id, it.contract_type
) m
LEFT JOIN policy_constant mc ON mc.const_key = 'EVAL_MIN_CLAUSES_PER_TYPE';

-- [G11 · G12 판정 지점] 성공 기준 확정 가능 여부 — 판정 대기 0건 · 측정 불가 유형 0건
CREATE OR REPLACE VIEW v_eval_confirmable AS
SELECT er.eval_run_id,
       (SELECT COUNT(*) FROM eval_evidence_review r WHERE r.eval_run_id = er.eval_run_id AND r.verdict IS NULL) AS pending_reviews,
       (SELECT COUNT(*) FROM v_eval_metric_live m WHERE m.eval_run_id = er.eval_run_id
         AND (m.measurable IS NULL OR m.measurable = FALSE)) AS unmeasurable_types,
       CASE WHEN (SELECT COUNT(*) FROM eval_evidence_review r WHERE r.eval_run_id = er.eval_run_id AND r.verdict IS NULL) = 0
             AND (SELECT COUNT(*) FROM v_eval_metric_live m WHERE m.eval_run_id = er.eval_run_id
                   AND (m.measurable IS NULL OR m.measurable = FALSE)) = 0
            THEN TRUE ELSE FALSE END AS confirmable
FROM eval_run er;

-- [유도] 피드백 현황 (S8 미검토·오탐·미탐 건수, 8.6)
CREATE OR REPLACE VIEW v_feedback_summary AS
SELECT kv_id,
       SUM(CASE WHEN review_status = 'unreviewed' THEN 1 ELSE 0 END) AS unreviewed_cnt,
       SUM(CASE WHEN feedback_type = 'false_positive' THEN 1 ELSE 0 END) AS false_positive_cnt,
       SUM(CASE WHEN feedback_type = 'false_negative' THEN 1 ELSE 0 END) AS false_negative_cnt
FROM feedback
GROUP BY kv_id;

-- [게이트 표시 지점] 해제되지 않은 게이트 — C2 블록 제목은 gate_def 한 곳에서 (SD_02 규칙 ④)
CREATE OR REPLACE VIEW v_gate_open AS
SELECT g.event_id, g.gate_code, d.title_text, d.release_actor, d.block_scope, g.reason_code, g.reason_detail,
       g.occurred_at, g.user_id, g.session_id, g.request_id, g.run_id, g.assessment_id, g.judgment_id,
       g.batch_id, g.ingest_item_id, g.eval_run_id, g.eval_item_id, g.contract_type, g.feedback_id
FROM gate_event g
JOIN gate_def d ON d.gate_code = g.gate_code
WHERE g.released_at IS NULL;

-- [감사] 원본 보관 기한 초과 — SC-014 점검 (0건이어야 한다)
CREATE OR REPLACE VIEW v_raw_retention_overdue AS
SELECT d.document_id, d.request_id, d.raw_delete_due_at
FROM document d
WHERE d.raw_deleted_at IS NULL AND d.raw_file_ref IS NOT NULL AND d.raw_delete_due_at < CURRENT_TIMESTAMP;

-- [마스킹] 계정 표시(S6 "***@***.kr") — 화면은 이 뷰만 조회한다  [DBMS] 3)
CREATE OR REPLACE VIEW v_user_masked AS
SELECT user_id, role, CONCAT('***@***.', SUBSTRING_INDEX(email, '.', -1)) AS email_masked
FROM app_user;

-- =====================================================================
-- 트리거 — CHECK 로 표현할 수 없는 다중 행·시점 의존 규칙  [DBMS] 4)
-- =====================================================================
DELIMITER //

-- BR-ANL-05: 최초 분석은 요청 시 고정한 기준일로, 재분석은 같은 요청의 이전 결과에서만
DROP TRIGGER IF EXISTS trg_run_bi //
CREATE TRIGGER trg_run_bi BEFORE INSERT ON analysis_run FOR EACH ROW
BEGIN
  IF NEW.run_kind = 'analysis' AND NEW.kv_id <> (SELECT fixed_kv_id FROM analysis_request WHERE request_id = NEW.request_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-ANL-05: analysis run must use the request fixed knowledge version';
  END IF;
  IF NEW.run_kind = 'reanalysis' AND NOT EXISTS (SELECT 1 FROM analysis_run p WHERE p.run_id = NEW.prev_run_id
                                                 AND p.request_id = NEW.request_id AND p.stage = 'saved') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UC5: reanalysis must reference a saved result of the same request';
  END IF;
END //

-- BR-EVD-03: 판정에 붙는 근거는 그 판정 기준일에 유효해야 한다 — 판정은 v_evidence_in_force 한 곳에서
DROP TRIGGER IF EXISTS trg_je_bi //
CREATE TRIGGER trg_je_bi BEFORE INSERT ON judgment_evidence FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM v_evidence_in_force f JOIN judgment j ON j.kv_id = f.kv_id
                 WHERE j.judgment_id = NEW.judgment_id AND f.evidence_version_id = NEW.evidence_version_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-EVD-03: evidence is not in force for the judgment knowledge version';
  END IF;
END //

-- BR-MDL-04: 조항 판정이 가리키는 캐시 행의 키 4필드가 그 조항·문서·요청·실행과 같아야 한다
DROP TRIGGER IF EXISTS trg_ca_bi //
CREATE TRIGGER trg_ca_bi BEFORE INSERT ON clause_assessment FOR EACH ROW
BEGIN
  IF NEW.judgment_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM judgment j, clause c, document d, analysis_request q, analysis_run r
       WHERE j.judgment_id = NEW.judgment_id AND c.clause_id = NEW.clause_id AND d.document_id = c.document_id
         AND r.run_id = NEW.run_id AND q.request_id = r.request_id
         AND j.text_hash = c.text_hash AND j.contract_type = d.contract_type
         AND j.perspective = q.perspective AND j.kv_id = r.kv_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-MDL-04: judgment cache key does not match clause/document/request/run';
  END IF;
END //
DROP TRIGGER IF EXISTS trg_ca_bu //
CREATE TRIGGER trg_ca_bu BEFORE UPDATE ON clause_assessment FOR EACH ROW
BEGIN
  IF NEW.judgment_id IS NOT NULL AND NOT (OLD.judgment_id <=> NEW.judgment_id) AND NOT EXISTS (
       SELECT 1 FROM judgment j, clause c, document d, analysis_request q, analysis_run r
       WHERE j.judgment_id = NEW.judgment_id AND c.clause_id = NEW.clause_id AND d.document_id = c.document_id
         AND r.run_id = NEW.run_id AND q.request_id = r.request_id
         AND j.text_hash = c.text_hash AND j.contract_type = d.contract_type
         AND j.perspective = q.perspective AND j.kv_id = r.kv_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-MDL-04: judgment cache key does not match clause/document/request/run';
  END IF;
  -- UC2 사후조건 3: 판정이 바뀌는 경로는 "분석 불가" 조항 다시 분석(A9) 하나뿐
  IF NOT (OLD.judgment_id <=> NEW.judgment_id) AND OLD.status <> 'unanalyzable' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UC2 A9: only unanalyzable clauses can be re-judged';
  END IF;
END //

-- BR-ANL-02 · SD_01 §7-3: 판정은 불변. 설명 재생성(UC3 E3)은 재생성 횟수만 0→1 로 바꾼다
DROP TRIGGER IF EXISTS trg_j_bu //
CREATE TRIGGER trg_j_bu BEFORE UPDATE ON judgment FOR EACH ROW
BEGIN
  IF NOT (OLD.m3_category <=> NEW.m3_category AND OLD.risk_type <=> NEW.risk_type AND OLD.risk_level <=> NEW.risk_level
          AND OLD.confidence <=> NEW.confidence AND OLD.text_hash <=> NEW.text_hash AND OLD.contract_type <=> NEW.contract_type
          AND OLD.perspective <=> NEW.perspective AND OLD.kv_id <=> NEW.kv_id AND OLD.m3_model_version <=> NEW.m3_model_version) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-ANL-02: judgment is immutable (only explanation may be regenerated)';
  END IF;
  IF NEW.explanation_regen_count < OLD.explanation_regen_count THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UC3 E3: regeneration count cannot decrease';
  END IF;
END //

-- BR-MDL-05 · 3.9/6.7: 사용량은 저장된 결과에만 차감한다(G5 중단은 차감 없음)
DROP TRIGGER IF EXISTS trg_uc_bi //
CREATE TRIGGER trg_uc_bi BEFORE INSERT ON usage_charge FOR EACH ROW
BEGIN
  IF NEW.run_id IS NULL OR NOT EXISTS (SELECT 1 FROM analysis_run r WHERE r.run_id = NEW.run_id AND r.stage = 'saved') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-MDL-03: usage is charged only for a saved result';
  END IF;
END //

-- BR-FDB-01: 피드백의 기준일·판정·표시 판정은 대상 조항 판정과 일치해야 한다 — 표시 판정은 v_assessment_display 에서
DROP TRIGGER IF EXISTS trg_fb_bi //
CREATE TRIGGER trg_fb_bi BEFORE INSERT ON feedback FOR EACH ROW
BEGIN
  IF NEW.assessment_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-FDB-01: feedback must reference a clause assessment when submitted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM v_assessment_display v JOIN analysis_run r ON r.run_id = v.run_id
                 WHERE v.assessment_id = NEW.assessment_id AND r.kv_id = NEW.kv_id
                   AND v.judgment_id <=> NEW.judgment_id AND v.display_category = NEW.category_at_submit) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'BR-FDB-01: feedback knowledge version/judgment/category must match the assessment';
  END IF;
END //

-- UC9 A2 · H5: 평가 데이터 후보는 "타당" 판단된 피드백에서만, 그리고 G13 가림 처리가 끝난 것만
DROP TRIGGER IF EXISTS trg_ecand_bi //
CREATE TRIGGER trg_ecand_bi BEFORE INSERT ON eval_candidate FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM feedback f WHERE f.feedback_id = NEW.feedback_id AND f.review_decision = 'valid') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'UC9 A2: only feedback judged valid can become an evaluation candidate';
  END IF;
  -- G13 · BR-PRV-04: 가림 처리가 끝나지 않은 피드백은 평가 데이터 후보가 될 수 없다
  IF EXISTS (SELECT 1 FROM gate_event g WHERE g.gate_code = 'G13' AND g.feedback_id = NEW.feedback_id AND g.released_at IS NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'G13: feedback with unmasked personal data cannot become an evaluation candidate';
  END IF;
END //

-- G11 · G12: 판정 대기·측정 불가가 남아 있으면 성공 기준을 확정할 수 없다 — 판정은 v_eval_confirmable 에서
DROP TRIGGER IF EXISTS trg_er_bu //
CREATE TRIGGER trg_er_bu BEFORE UPDATE ON eval_run FOR EACH ROW
BEGIN
  IF OLD.sc_confirmed_at IS NULL AND NEW.sc_confirmed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM v_eval_confirmable c WHERE c.eval_run_id = NEW.eval_run_id AND c.confirmable = TRUE) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'G11/G12: success criteria cannot be confirmed while reviews are pending or types unmeasurable';
  END IF;
END //

DELIMITER ;

-- =====================================================================
-- 기준 데이터 (멱등: 없을 때만 넣는다)
-- =====================================================================

INSERT INTO policy_constant (const_key, value_num, unit, source_ref, status)
SELECT * FROM (
  SELECT 'FREE_MONTHLY_LIMIT' AS k, 3.00 AS v, 'count' AS u, 'FR-035 · BR-INP-04' AS s, 'confirmed' AS st UNION ALL
  SELECT 'FILE_MAX_MB', 50.00, 'MB', 'FR-002 · BR-INP-02', 'confirmed' UNION ALL
  SELECT 'FILE_MAX_PAGES', 300.00, 'page', 'FR-002 · BR-INP-02', 'confirmed' UNION ALL
  SELECT 'RAW_RETENTION_HOURS', 24.00, 'hour', 'FR-007 · BR-PRV-02 · SC-014', 'confirmed' UNION ALL
  SELECT 'KNW_REFLECT_DAYS', 7.00, 'day', 'SC-015 · BR-KNW-03', 'confirmed' UNION ALL
  SELECT 'BIAS_GAP_PP', 15.00, 'pp', 'SC-007 · BR-QA-02', 'confirmed' UNION ALL
  SELECT 'SC_RECALL_PCT', 85.00, 'pct', 'SC-001', 'confirmed' UNION ALL
  SELECT 'SC_PRECISION_PCT', 70.00, 'pct', 'SC-002', 'confirmed' UNION ALL
  SELECT 'SC_EVIDENCE_FIT_PCT', 90.00, 'pct', 'SC-004', 'confirmed' UNION ALL
  SELECT 'MODEL_TIMEOUT_SEC', 30.00, 'second', 'BR-MDL-03 [가정]', 'assumed' UNION ALL
  SELECT 'MODEL_RETRY', 1.00, 'count', 'BR-MDL-03 [가정]', 'assumed' UNION ALL
  SELECT 'DETECT_THRESHOLD_M1', NULL, 'score', 'BR-MDL-06 [확인 필요] 미해결 18', 'unknown' UNION ALL
  SELECT 'DETECT_THRESHOLD_M2', NULL, 'score', 'BR-MDL-06 [확인 필요] 미해결 18', 'unknown' UNION ALL
  SELECT 'EVAL_MIN_CLAUSES_PER_TYPE', NULL, 'count', 'UC8 E2 미해결 5', 'unknown' UNION ALL
  SELECT 'ANON_SESSION_TTL_HOURS', NULL, 'hour', 'FR-032 미해결 P-2', 'unknown' UNION ALL
  SELECT 'REFLECT_WARN_DAYS', NULL, 'day', 'UC7 E3 경고 시점 [추론]', 'unknown'
) x
WHERE NOT EXISTS (SELECT 1 FROM policy_constant p WHERE p.const_key = x.k);

INSERT INTO contract_type_code (contract_type, label_ko, in_scope)
SELECT * FROM (
  SELECT 'ecommerce' AS c, '전자상거래' AS l, TRUE AS s UNION ALL
  SELECT 'subscription', '구독', TRUE UNION ALL
  SELECT 'installment', '할부', TRUE UNION ALL
  SELECT 'door_to_door', '방문판매', TRUE UNION ALL
  SELECT 'general_consumer', '일반 소비자 거래', TRUE UNION ALL
  SELECT 'out_of_scope', '범위 밖', FALSE
) x
WHERE NOT EXISTS (SELECT 1 FROM contract_type_code t WHERE t.contract_type = x.c);

INSERT INTO gate_def (gate_code, gate_name, ipo_steps, block_scope, release_actor, title_text)
SELECT * FROM (
  SELECT 'G0' AS g, '외부 기관 수집 실패' AS n, 'P0 0.1' AS p, 'full' AS sc, 'operator' AS a, '외부 자료를 모두 받지 못했습니다' AS t UNION ALL
  SELECT 'G1', '구조 분리 실패', 'P0 0.2', 'partial', 'operator', '구조 분리 실패 - 이번 반영에서 제외됩니다' UNION ALL
  SELECT 'G2', '파일 조건 미충족', 'P1 1.3', 'full', 'user', '파일 조건을 충족하지 않습니다' UNION ALL
  SELECT 'G3', 'URL 본문 수집 실패', 'P1 1.4', 'full', 'user', 'URL 본문을 가져올 수 없습니다' UNION ALL
  SELECT 'G4', '무료 한도 초과', 'P1 1.5 · P6 6.5', 'full', 'system', '이번 달 무료 분석을 모두 사용했습니다' UNION ALL
  SELECT 'G5', '모델 API 서버 불가', 'P1 1.6 · P3 3.6 · P4 4.5 · P6 6.5 · P7 7.5', 'full', 'operator', '분석 일시 불가' UNION ALL
  SELECT 'G6', '계약서 아님', 'P2 2.2', 'full', 'user', '계약서·약관으로 인식되지 않았습니다' UNION ALL
  SELECT 'G7', '관점 간 판정 불일치', 'P3 3.7', 'full', 'operator', '결과 제공 보류' UNION ALL
  SELECT 'G8', '접근 권한 없음(세션·로그인·소유)', 'P4 4.1 · P5 5.1 · P6 6.1·6.2', 'full', 'user', '접근할 수 없습니다' UNION ALL
  SELECT 'G9', '설명 제공 불가', 'P4 4.8', 'partial', 'system', '설명 제공 불가' UNION ALL
  SELECT 'G10', '부적격 평가 조항', 'P7 7.4', 'partial', 'legal_expert', '평가에서 제외된 조항' UNION ALL
  SELECT 'G11', '전문가 판정 미회신', 'P7 7.7', 'partial', 'legal_expert', '근거 적합률 판정 대기' UNION ALL
  SELECT 'G12', '유형별 평가 조항 부족', 'P7 7.4', 'partial', 'operator_expert', '측정 불가' UNION ALL
  SELECT 'G13', '비식별화되지 않은 민감정보', 'P8 8.3', 'partial', 'system', '비식별화되지 않은 개인정보가 발견되었습니다' UNION ALL
  SELECT 'G14', '운영자·개발자 권한 없음', 'P9 9.1', 'full', 'operator', '접근 권한이 없습니다'
) x
WHERE NOT EXISTS (SELECT 1 FROM gate_def d WHERE d.gate_code = x.g);

-- =====================================================================
-- [이탈 기록] 실행 중 논리 설계와 달라진 곳
-- 이탈 1. fk_run_prev 에 ON DELETE CASCADE 추가.
--   논리 설계에서는 재분석 결과가 이전 결과를 참조만 했다(삭제 규칙 없음). 위반 거부 검증 중
--   "사용자 기록 영구 삭제"(BR-PRV-03) 가 ERROR 1451 로 막혔다 — 요청 삭제가 실행(run)을 연쇄 삭제할 때
--   재분석 행이 이전 행을 RESTRICT 로 붙잡았다. 삭제 단위는 요청 전체(SD_02 S6 "기록 삭제")이므로
--   이전 결과와 함께 재분석 결과도 지워지는 것이 맞다. SET NULL 은 chk_run_prev 와 충돌해 쓰지 않았다.
-- 이탈 2. v_quota_current.remaining 에 CAST(… AS INTEGER).
--   policy_constant.value_num 이 DECIMAL 이라 남은 한도가 "2.00" 으로 나왔다. 화면 C10 은 정수 건수를 표시한다.
-- =====================================================================
