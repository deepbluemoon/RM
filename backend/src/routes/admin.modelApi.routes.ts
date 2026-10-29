// /api/admin/model-api/* (US7 P9 T140, SD_02 §13 S9) — 안내·OpenAPI·Try it out 은 modelApi.view(사용자·운영자),
// 서버 상태·운영 문서는 modelApi.manage(운영자). 모델 서버 장애여도 status 는 200 으로 상태만 싣는다(UC10 E2). 서버 키는 응답하지 않는다(BR-API-02)
// 2026-09-30: 이용자별 API 키 — /api/api-keys(내 키), /api/admin/api-keys(전체, 운영자), 외부 호출 /api/model/<경로>(발급 키로 확인)
import { Router, type Request } from 'express';
import { ah } from '../middleware/guards.js';
import { HttpError } from '../middleware/errorHandler.js';
import { can } from '../modules/auth/rbac.js';
import { issueKey, listAllKeys, listMyKeys, revokeKey, verifyBearer } from '../modules/modelApiGuide/apiKey.service.js';
import { modelApiStatus } from '../modules/modelApiGuide/status.service.js';
import { forDocsPage, modelOpenapi } from '../modules/modelApiGuide/openapi.service.js';
import { isModelDocName, readModelDoc } from '../modules/modelApiGuide/docs.service.js';
import { forwardTry, isAllowedTry } from '../modules/modelApiGuide/tryProxy.service.js';

export const adminModelApiRouter = Router();

/** 9.5·9.6 — 수동 새로고침은 ?refresh=1(캐시 무시). 자동 새로고침 없음 */
adminModelApiRouter.get('/admin/model-api/status', ah(async (req, res) => {
  res.json(await modelApiStatus(req.query.refresh === '1'));
}));

/** 모델 서버 운영 문서(가이드라인·매뉴얼·점검 결과·모델 테스트 보고서) — 정해진 이름만, 없으면 404 */
adminModelApiRouter.get('/admin/model-api/docs/:name', ah(async (req, res) => {
  const name = String(req.params.name);
  const doc = isModelDocName(name) ? await readModelDoc(name) : null;
  if (!doc) {
    res.status(404).json({ code: 'MODEL_DOC_NOT_FOUND', message: '문서를 찾을 수 없습니다' });
    return;
  }
  res.json(doc);
}));

/** 모델 API 프록시 — 계약 경로만. 발급받은 API 키(Authorization: Bearer crd_…)를 확인한 뒤 서버 키로 넘긴다 */
const tryHandler = ah(async (req, res) => {
  const path = '/' + String((req.params as Record<string, string>)[0] ?? '');
  const method = req.method as 'GET' | 'POST';
  if (!isAllowedTry(method, path)) {
    res.status(404).json({ code: 'MODEL_API_PATH_NOT_ALLOWED', message: '허용되지 않은 모델 API 경로입니다' });
    return;
  }
  if (!(await verifyBearer(req.headers.authorization))) {
    res.status(401).json({ code: 'api_key_invalid', message: 'API 키가 없거나 맞지 않습니다. API 활용 화면의 "API 키" 탭에서 발급받은 키를 Authorization: Bearer <키> 로 넣어 주세요' });
    return;
  }
  try {
    const r = await forwardTry(method, path, req.body);
    res.status(r.status).type(r.contentType).send(r.body);
  } catch {
    res.status(502).json({ code: 'model_api_unreachable', message: '모델 서버에 연결할 수 없습니다' });
  }
});
adminModelApiRouter.get('/admin/model-api/try/*', tryHandler);
adminModelApiRouter.post('/admin/model-api/try/*', tryHandler);
// 외부 프로그램용 — 로그인 세션 없이 API 키만으로(rbac.ts PUBLIC)
adminModelApiRouter.get('/model/*', tryHandler);
adminModelApiRouter.post('/model/*', tryHandler);

const keyId = (req: Request): number => {
  const n = Number(req.params.keyId);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'api_key_not_found', '키를 찾을 수 없습니다');
  return n;
};

/** 내 API 키 — 목록·발급(원문은 발급 응답에서 한 번만)·폐기 */
adminModelApiRouter.get('/api-keys', ah(async (req, res) => {
  res.json({ items: await listMyKeys(req.owner.userId) });
}));
adminModelApiRouter.post('/api-keys', ah(async (req, res) => {
  res.status(201).json(await issueKey(req.owner.userId, req.body?.name));
}));
adminModelApiRouter.delete('/api-keys/:keyId', ah(async (req, res) => {
  if (!(await revokeKey(keyId(req), req.owner.userId, false))) throw new HttpError(404, 'api_key_not_found', '키를 찾을 수 없거나 이미 폐기되었습니다');
  res.status(204).end();
}));

/** 전체 API 키(운영자) — 누가 어떤 키를 쓰는지 보고 폐기한다 */
adminModelApiRouter.get('/admin/api-keys', ah(async (_req, res) => {
  res.json({ items: await listAllKeys() });
}));
adminModelApiRouter.delete('/admin/api-keys/:keyId', ah(async (req, res) => {
  const admin = !!req.auth && can(req.auth.role, 'modelApi.manage');
  if (!(await revokeKey(keyId(req), req.owner.userId, admin))) throw new HttpError(404, 'api_key_not_found', '키를 찾을 수 없거나 이미 폐기되었습니다');
  res.status(204).end();
}));

/** 9.7 — 모델 서버 /openapi.json 프록시(없으면 계약 원본). 연결 불가는 502 */
adminModelApiRouter.get('/admin/model-api/openapi', ah(async (req, res) => {
  const r = await modelOpenapi(req.query.refresh === '1');
  if (!r.ok) {
    res.status(r.status).json({ code: r.code, message: r.message, httpStatus: r.httpStatus });
    return;
  }
  res.setHeader('X-Openapi-Source', r.source);
  if (r.yamlText !== undefined) res.type('application/yaml').send(r.yamlText);
  else res.json(req.query.view === 'docs' ? forDocsPage(r.doc) : r.doc); // ?view=docs → /docs(Swagger) 용
}));
