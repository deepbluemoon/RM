-- =====================================================================
-- 007_local_login_api_key.sql — 아이디·비밀번호 로그인(회원가입)과 이용자별 API 키 발급(2026-09-30)
-- 근거: 웹 개선 요청(2026-09-30) — 간편(소셜) 로그인 대신 아이디·비밀번호 회원가입, 역할은 운영자·사용자 두 부류,
--       API 는 발급받은 키로 쓴다. 002 의 "비밀번호를 저장하지 않는다"(FR-043)를 이 요청이 대체한다.
-- 비밀번호는 scrypt 해시만 저장한다(원문 저장·로그 금지). API 키도 sha256 해시와 앞 8자리(표시용)만 저장한다.
-- design/crd_ddl.sql 의 app_user 는 바꾸지 않는다 — 이름·비밀번호는 별도 테이블에 둔다.
-- 멱등: DROP CONSTRAINT IF EXISTS · CREATE TABLE IF NOT EXISTS · ON DUPLICATE KEY UPDATE
-- =====================================================================

-- auth_identity 에 'local'(아이디·비밀번호) 제공자를 더한다. provider_subject = 로그인 아이디
ALTER TABLE auth_identity DROP CONSTRAINT IF EXISTS chk_ai_provider;
ALTER TABLE auth_identity ADD CONSTRAINT chk_ai_provider CHECK (provider IN ('kakao','naver','dev','local'));

-- 아이디·비밀번호 계정. 이름은 회원가입 때 받은 표시 이름(머리글·계정 메뉴에 보인다)
CREATE TABLE IF NOT EXISTS auth_password (
  user_id        BIGINT        NOT NULL,
  login_id       VARCHAR(32)   NOT NULL,     -- 소문자 정규화
  password_hash  VARCHAR(255)  NOT NULL,     -- scrypt$N$r$p$salt$hash
  display_name   VARCHAR(40)   NOT NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT pk_auth_password PRIMARY KEY (user_id),
  CONSTRAINT uq_ap_login_id UNIQUE (login_id),
  CONSTRAINT fk_ap_user FOREIGN KEY (user_id) REFERENCES app_user (user_id) ON DELETE CASCADE
);

-- 이용자별 API 키. 원문은 발급 순간 한 번만 보여 주고 저장하지 않는다
CREATE TABLE IF NOT EXISTS api_key (
  key_id        BIGINT        NOT NULL AUTO_INCREMENT,
  user_id       BIGINT        NOT NULL,
  name          VARCHAR(40)   NOT NULL,
  key_prefix    VARCHAR(16)   NOT NULL,      -- 'crd_' + 앞 8자 — 목록에서 어떤 키인지 알아보는 용도
  key_hash      CHAR(64)      NOT NULL,      -- sha256(원문) hex
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TIMESTAMP     NULL,
  revoked_at    TIMESTAMP     NULL,
  revoked_by    BIGINT        NULL,
  CONSTRAINT pk_api_key PRIMARY KEY (key_id),
  CONSTRAINT uq_api_key_hash UNIQUE (key_hash),
  CONSTRAINT fk_ak_user FOREIGN KEY (user_id) REFERENCES app_user (user_id) ON DELETE CASCADE,
  CONSTRAINT fk_ak_revoked_by FOREIGN KEY (revoked_by) REFERENCES app_user (user_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_api_key_user ON api_key (user_id);

-- 권한: 사용자도 API 활용(안내·키 발급)을 쓴다. 서버 상태·매뉴얼·점검 문서와 전체 키 관리는 새 권한 modelApi.manage(운영자)
INSERT INTO role_permission (role, permission, allowed) VALUES
  ('user','modelApi.view',1), ('user','modelApi.manage',0),
  ('operator','modelApi.manage',1), ('developer','modelApi.manage',1), ('legal_expert','modelApi.manage',0)
ON DUPLICATE KEY UPDATE allowed = VALUES(allowed);
