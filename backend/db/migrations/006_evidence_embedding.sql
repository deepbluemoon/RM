-- =====================================================================
-- 006_evidence_embedding.sql — 근거 임베딩(하이브리드 RAG: BM25 + 밀집 벡터, 2026-09-29)
-- 임베딩 모델 = 공유 Ollama bge-m3(1024차원, "서비스당 임베딩 모델 1개" 규칙). 게이트웨이 /v1/embed 로 만든다.
-- evidence_version 은 불변이므로 버전 1개 = 벡터 1개(모델별). 모델이 바뀌면 model 값이 달라 섞이지 않는다.
-- 벡터는 승인 커밋 뒤 별도 작업으로 채운다(없으면 검색은 BM25 만으로 동작) — 적재 트랜잭션에 넣지 않는다.
-- 벡터 인덱스(HNSW)는 두지 않는다: 근거 수천 건은 기준일 필터 후 정확 계산이 더 정확하고 충분히 빠르다(수 ms).
-- design/crd_ddl.sql 은 바꾸지 않는다. 멱등: CREATE TABLE IF NOT EXISTS
-- =====================================================================

CREATE TABLE IF NOT EXISTS evidence_embedding (
  evidence_version_id BIGINT       NOT NULL,
  model               VARCHAR(60)  NOT NULL,     -- 'bge-m3@<digest 앞 12자>'
  embedding           VECTOR(1024) NOT NULL,     -- 정규화(L2=1)한 float32
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_evidence_embedding PRIMARY KEY (evidence_version_id, model),
  CONSTRAINT fk_ee_version FOREIGN KEY (evidence_version_id) REFERENCES evidence_version (evidence_version_id),
  CONSTRAINT chk_ee_model CHECK (CHAR_LENGTH(model) > 0)
);
