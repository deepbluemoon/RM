// S9 API 활용 — 모델 서버 운영 문서 열람(2026-09-29). 정해진 파일 4개만 읽는다(요청 값으로 경로를 만들지 않음).
// 원본: model-server/docs/{GUIDELINE,USER_MANUAL}.md, service-test-result.json(scripts/service_test.py 결과),
// model-server/reports/baseline_v0/MODEL_TEST_REPORT.md. 문서에는 API 키를 쓰지 않는다(BR-API-02) — .env 는 대상이 아니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { REPO_ROOT } from '../../config/env.js';

const MS = path.join(REPO_ROOT, 'model-server');

export const MODEL_DOCS = {
  guideline: { title: '운영 가이드라인', format: 'markdown', file: path.join(MS, 'docs', 'GUIDELINE.md') },
  manual: { title: '사용자 매뉴얼', format: 'markdown', file: path.join(MS, 'docs', 'USER_MANUAL.md') },
  'test-result': { title: '서비스 점검 결과', format: 'json', file: path.join(MS, 'docs', 'service-test-result.json') },
  'model-test': { title: '모델 테스트 보고서(baseline_v0)', format: 'markdown', file: path.join(MS, 'reports', 'baseline_v0', 'MODEL_TEST_REPORT.md') },
} as const;

export type ModelDocName = keyof typeof MODEL_DOCS;

export interface ModelDoc {
  name: ModelDocName;
  title: string;
  format: 'markdown' | 'json';
  updatedAt: string;
  content: unknown;
}

export const isModelDocName = (v: string): v is ModelDocName => Object.hasOwn(MODEL_DOCS, v);

/** 파일이 없으면 null(→ 404). 매번 디스크에서 읽는다 — 점검을 다시 돌리면 바로 반영된다 */
export async function readModelDoc(name: ModelDocName): Promise<ModelDoc | null> {
  const d = MODEL_DOCS[name];
  try {
    const [text, st] = await Promise.all([fs.readFile(d.file, 'utf8'), fs.stat(d.file)]);
    return {
      name,
      title: d.title,
      format: d.format,
      updatedAt: st.mtime.toISOString(),
      content: d.format === 'json' ? JSON.parse(text) : text,
    };
  } catch {
    return null;
  }
}
