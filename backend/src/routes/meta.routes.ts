// GET /api/meta/codes · /api/meta/privacy-notice · /api/model-server/status (T034)
import { Router } from 'express';
import { ah } from '../middleware/guards.js';
import { codesDictionary, PII_LABEL } from '../domain/codes.js';
import { GATE_MESSAGES, NOTICES } from '../modules/gates/messages.js';
import { getServerStatus } from '../modules/modelApi/status.js';
import { policy } from '../config/policy.js';

export const metaRouter = Router();

metaRouter.get('/meta/codes', (_req, res) => {
  res.json({ ...codesDictionary(), gates: GATE_MESSAGES, notices: NOTICES });
});

/** FR-010 개인정보 처리 고지 — 비식별화 8종, 원본 24시간, 계정별 기록 보관, 삭제 방법, 피드백 익명 보존 */
metaRouter.get('/meta/privacy-notice', (_req, res) => {
  const rawHours = policy('RAW_RETENTION_HOURS');
  const types = Object.values(PII_LABEL);
  const items = [
    `업로드한 문서의 개인정보(${types.join('·')} 8종)는 분석 전에 〔유형〕 표시로 가립니다. 가린 텍스트만 저장하고 분석 모델에 보냅니다.`,
    `원본 파일은 암호화해 임시 보관하고 분석을 마친 뒤 ${rawHours}시간 안에 삭제합니다.`,
    '분석 결과는 로그인한 계정의 분석 기록에 보관되며, 다른 계정에서는 보이지 않습니다.',
    '결과 화면의 [삭제] 또는 분석 기록에서 언제든 문서와 결과를 영구 삭제할 수 있습니다.',
    '결과를 삭제해도 그 결과에 남긴 피드백은 누구의 것인지 알 수 없는 형태(작성자·대상 연결 제거)로만 남습니다.',
  ];
  res.json({ items, rawRetentionHours: rawHours, piiTypes: types, html: `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>` });
});

/** C11 사용자 화면용 — ready/loading/unreachable + 콜드 스타트 안내(model-serving §0.1). 새로 고침은 ?refresh=1 (수동) */
metaRouter.get(
  '/model-server/status',
  ah(async (req, res) => {
    const s = await getServerStatus(req.query.refresh === '1');
    res.json({
      state: s.state,
      checkedAt: s.checkedAt,
      coldStart: s.coldStart,
      warmupEstimateSec: s.warmupEstimateSec,
      models: s.models.map((m) => ({ id: m.id, state: m.state })),
    });
  }),
);
