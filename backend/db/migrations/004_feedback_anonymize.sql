-- =====================================================================
-- 004_feedback_anonymize.sql — 결과 삭제 시 피드백 익명 보존(FR-008, data-model A16, Clarify 2026-09-28)
-- design/crd_ddl.sql 의 chk_fb_owner(user_id 또는 session_id 필수)는 "누구의 것인지 알 수 없는 형태로 남긴다"는
-- 확정 정책과 충돌한다(삭제 시 익명화 UPDATE 가 거부됨). DDL 은 고치지 않고 같은 규칙을 시점별로 나눠 다시 건다:
--   · 제출(INSERT) — 소유자 필수: 트리거 trg_fb_bi_owner (trg_fb_bi 의 BR-FDB-01 대상 필수 검사 뒤)
--   · 익명화(UPDATE) — 소유자를 비울 때는 대상 조항·판정 연결도 함께 비워야 한다: 트리거 trg_fb_bu_owner
-- CHECK 로 쓰지 않는 이유: assessment_id 는 ON DELETE SET NULL 외래 키라 MariaDB 가 CHECK 에서 참조를 막는다.
-- 멱등: DROP … IF EXISTS 후 다시 만든다
-- =====================================================================

ALTER TABLE feedback DROP CONSTRAINT IF EXISTS chk_fb_owner;

DELIMITER //
DROP TRIGGER IF EXISTS trg_fb_bi_owner //
CREATE TRIGGER trg_fb_bi_owner BEFORE INSERT ON feedback FOR EACH ROW FOLLOWS trg_fb_bi
BEGIN
  IF NEW.user_id IS NULL AND NEW.session_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chk_fb_owner: feedback must have an owner (user or session) when submitted';
  END IF;
END //

DROP TRIGGER IF EXISTS trg_fb_bu_owner //
CREATE TRIGGER trg_fb_bu_owner BEFORE UPDATE ON feedback FOR EACH ROW
BEGIN
  IF NEW.user_id IS NULL AND NEW.session_id IS NULL
     AND (NEW.assessment_id IS NOT NULL OR NEW.judgment_id IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chk_fb_owner: anonymized feedback must not keep its clause or judgment link (FR-008)';
  END IF;
END //
DELIMITER ;
