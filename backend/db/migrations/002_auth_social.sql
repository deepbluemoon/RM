-- =====================================================================
-- 002_auth_social.sql — 소셜 로그인(카카오·네이버) 식별자와 HTTP 세션 저장소
-- 근거: spec FR-043 (Clarify 2026-09-28) — 비밀번호를 저장하지 않는다. research R-10 개정.
-- design/crd_ddl.sql 의 app_user 는 바꾸지 않는다(인증 수단 컬럼 없음 — 미해결 6).
-- app_user.email(NOT NULL UNIQUE) 에는 합성 식별자 {provider}.{sha256(subject) 앞 16자}@social.invalid 를 넣는다.
-- 멱등: CREATE TABLE IF NOT EXISTS · CREATE INDEX IF NOT EXISTS
-- =====================================================================

-- 소셜 제공자 식별자 ↔ 이용자. 토큰·닉네임·이메일은 저장하지 않는다(식별자만)
CREATE TABLE IF NOT EXISTS auth_identity (
  identity_id       BIGINT       NOT NULL AUTO_INCREMENT,
  provider          VARCHAR(8)   NOT NULL,
  provider_subject  VARCHAR(128) NOT NULL,   -- 제공자가 준 사용자 고유 번호(카카오 id, 네이버 id)
  user_id           BIGINT       NOT NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at     TIMESTAMP    NULL,
  CONSTRAINT pk_auth_identity PRIMARY KEY (identity_id),
  CONSTRAINT fk_ai_user FOREIGN KEY (user_id) REFERENCES app_user (user_id) ON DELETE CASCADE,
  CONSTRAINT uq_ai_provider_subject UNIQUE (provider, provider_subject),
  -- dev 는 개발 환경 전용 제공자(AUTH_DEV_PROVIDER). 운영에서는 앱이 켜지 않는다
  CONSTRAINT chk_ai_provider CHECK (provider IN ('kakao','naver','dev'))
);
CREATE INDEX IF NOT EXISTS ix_ai_user ON auth_identity (user_id);

-- express-session 저장소(express-mysql-session). 세션 본문에는 user_id·역할·닉네임만 둔다
CREATE TABLE IF NOT EXISTS http_session (
  session_id  VARCHAR(128)  NOT NULL,
  expires     INT UNSIGNED  NOT NULL,   -- 만료 시각(epoch 초)
  data        MEDIUMTEXT    NULL,
  CONSTRAINT pk_http_session PRIMARY KEY (session_id)
);
CREATE INDEX IF NOT EXISTS ix_http_session_expires ON http_session (expires);
