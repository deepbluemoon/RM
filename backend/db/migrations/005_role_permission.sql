-- =====================================================================
-- 005_role_permission.sql — RBAC 역할(사용자 유형)별 기능 사용 여부(권한 관리 화면 S10, 2026-09-29)
-- 권한 = 유스케이스 단위(backend/src/modules/auth/rbac.ts PERMISSIONS). 행이 없으면 코드 기본값을 쓴다.
-- 끈 권한도 allowed=0 행으로 남겨 두어, 다시 적용해도(INSERT IGNORE) 관리자가 바꾼 값을 덮지 않는다.
-- design/crd_ddl.sql 의 app_user.role CHECK(4개 역할)는 바꾸지 않는다.
-- 멱등: CREATE TABLE IF NOT EXISTS · INSERT IGNORE
-- =====================================================================

CREATE TABLE IF NOT EXISTS role_permission (
  role        VARCHAR(12)  NOT NULL,
  permission  VARCHAR(32)  NOT NULL,
  allowed     TINYINT(1)   NOT NULL,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by  BIGINT       NULL,     -- 마지막으로 바꾼 운영자(app_user). 초기값은 NULL
  CONSTRAINT pk_role_permission PRIMARY KEY (role, permission),
  CONSTRAINT fk_rp_user FOREIGN KEY (updated_by) REFERENCES app_user (user_id) ON DELETE SET NULL,
  CONSTRAINT chk_rp_role CHECK (role IN ('user','operator','developer','legal_expert')),
  CONSTRAINT chk_rp_allowed CHECK (allowed IN (0,1))
);

-- 초기값 = 유스케이스 주액터(UC_00 §3). rbac.ts DEFAULT_ROLE_PERMISSIONS 와 같다
INSERT IGNORE INTO role_permission (role, permission, allowed) VALUES
  ('user','analysis.request',1), ('user','result.view',1), ('user','explanation.view',1), ('user','history.manage',1), ('user','feedback.submit',1),
  ('user','knowledge.manage',0), ('user','eval.run',0), ('user','eval.review',0), ('user','feedback.review',0), ('user','modelApi.view',0), ('user','rbac.manage',0),
  ('operator','analysis.request',0), ('operator','result.view',0), ('operator','explanation.view',0), ('operator','history.manage',0), ('operator','feedback.submit',0),
  ('operator','knowledge.manage',1), ('operator','eval.run',1), ('operator','eval.review',1), ('operator','feedback.review',1), ('operator','modelApi.view',1), ('operator','rbac.manage',1),
  ('legal_expert','analysis.request',0), ('legal_expert','result.view',0), ('legal_expert','explanation.view',0), ('legal_expert','history.manage',0), ('legal_expert','feedback.submit',0),
  ('legal_expert','knowledge.manage',0), ('legal_expert','eval.run',0), ('legal_expert','eval.review',1), ('legal_expert','feedback.review',0), ('legal_expert','modelApi.view',0), ('legal_expert','rbac.manage',0),
  ('developer','analysis.request',0), ('developer','result.view',0), ('developer','explanation.view',0), ('developer','history.manage',0), ('developer','feedback.submit',0),
  ('developer','knowledge.manage',0), ('developer','eval.run',0), ('developer','eval.review',0), ('developer','feedback.review',0), ('developer','modelApi.view',1), ('developer','rbac.manage',0);
