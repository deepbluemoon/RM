-- =====================================================================
-- 003_app_policy.sql — Clarify 2026-09-28 정책 반영 (design/crd_ddl.sql 은 수정하지 않는다)
--   (1) 비로그인 결과 보존 = 마지막 접근 후 24시간 (FR-032)
--   (2) 사용자 취소 차감 원장 cancel_charge (FR-035(b)) — trg_uc_bi 가 usage_charge 를 저장된 결과에만
--       허용하므로 취소 차감은 별도 원장에 둔다
--   (3) v_quota_effective — v_quota_current 와 같은 열, usage_charge + cancel_charge 이번 달 합 (G4 판정 지점)
-- 멱등: UPDATE 는 같은 값 재적용, CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE VIEW
-- =====================================================================

UPDATE policy_constant
   SET value_num = 24.00, status = 'confirmed', source_ref = 'FR-032 · Clarify 2026-09-28'
 WHERE const_key = 'ANON_SESSION_TTL_HOURS';

-- 취소 차감 원장. 요청을 지워도 차감 기록은 남는다(request_id 만 NULL) — 삭제로 한도를 되찾지 못하게
CREATE TABLE IF NOT EXISTS cancel_charge (
  cancel_id    BIGINT    NOT NULL AUTO_INCREMENT,
  request_id   BIGINT    NULL,
  user_id      BIGINT    NULL,
  session_id   CHAR(36)  NULL,
  charged_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- usage_charge.usage_month 와 같은 식 (달력 월 — 미해결 D-3)
  usage_month  INT GENERATED ALWAYS AS (EXTRACT(YEAR FROM charged_at) * 100 + EXTRACT(MONTH FROM charged_at)) STORED,
  CONSTRAINT pk_cancel_charge PRIMARY KEY (cancel_id),
  CONSTRAINT fk_cc_request FOREIGN KEY (request_id) REFERENCES analysis_request (request_id) ON DELETE SET NULL,
  CONSTRAINT fk_cc_user FOREIGN KEY (user_id) REFERENCES app_user (user_id),
  CONSTRAINT fk_cc_session FOREIGN KEY (session_id) REFERENCES anon_session (session_id),
  CONSTRAINT uq_cc_request UNIQUE (request_id),                -- 한 요청에 한 번만 차감
  CONSTRAINT chk_cc_owner CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_cc_user_month ON cancel_charge (user_id, usage_month);
CREATE INDEX IF NOT EXISTS ix_cc_session_month ON cancel_charge (session_id, usage_month);

-- [유도 · G4 판정 지점] 이번 달 사용량(저장 결과 + 사용자 취소)과 남은 한도. 열은 v_quota_current 와 같다
CREATE OR REPLACE VIEW v_quota_effective AS
SELECT q.user_id, q.device_key, SUM(q.cnt) AS used_cnt,
       CAST((SELECT value_num FROM policy_constant WHERE const_key = 'FREE_MONTHLY_LIMIT') - SUM(q.cnt) AS INTEGER) AS remaining
FROM (
  SELECT uc.user_id, CASE WHEN uc.user_id IS NULL THEN s.device_key END AS device_key, COUNT(*) AS cnt
  FROM usage_charge uc
  LEFT JOIN anon_session s ON s.session_id = uc.session_id
  WHERE uc.usage_month = EXTRACT(YEAR FROM CURRENT_DATE) * 100 + EXTRACT(MONTH FROM CURRENT_DATE)
  GROUP BY uc.user_id, CASE WHEN uc.user_id IS NULL THEN s.device_key END
  UNION ALL
  SELECT cc.user_id, CASE WHEN cc.user_id IS NULL THEN s.device_key END AS device_key, COUNT(*) AS cnt
  FROM cancel_charge cc
  LEFT JOIN anon_session s ON s.session_id = cc.session_id
  WHERE cc.usage_month = EXTRACT(YEAR FROM CURRENT_DATE) * 100 + EXTRACT(MONTH FROM CURRENT_DATE)
  GROUP BY cc.user_id, CASE WHEN cc.user_id IS NULL THEN s.device_key END
) q
GROUP BY q.user_id, q.device_key;
