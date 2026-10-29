// 모델 API 스텁(T031·T123) — 조항 텍스트 해시와 키워드로 점수·판정을 결정적으로 만든다.
// 동작 제어(환경 변수 또는 createStubApp(config) 의 config 를 테스트에서 바꾼다):
//   STUB_HEALTH=ready|loading|down   /health 상태 (down = 연결 끊김)
//   STUB_COLD=true                    M3·M4 를 cold 로 보고(공유 Ollama 유휴 언로드 흉내, 첫 호출 지연 STUB_COLD_DELAY_MS)
//   STUB_TIMEOUT_MATCH=<문자열>        그 문자열을 포함한 조항은 /v1/judge 35초 지연·/v1/jobs 조항 오류 timeout
//   STUB_API_KEY=<키>                 설정 시 Bearer 불일치면 401
//   STUB_UNKNOWN_LABEL=true           /v1/judge 가 모르는 라벨을 돌려준다
//   STUB_PERSPECTIVE_DIVERGE=true     사업자 관점이면 분류를 한 단계 바꾼다(G7 재현)
//   STUB_SUMMARY_FAIL=true            /v1/summarize 503
//   STUB_JUDGE_DELAY_MS=<ms>          모든 /v1/judge 지연(탐지 중 취소 재현)
import crypto from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';

export interface StubConfig {
  health: 'ready' | 'loading' | 'down';
  cold: boolean;
  coldDelayMs: number;
  timeoutMatch: string;
  timeoutDelayMs: number;
  apiKey: string;
  unknownLabel: boolean;
  perspectiveDiverge: boolean;
  summaryFail: boolean;
  /** 모든 /v1/judge 응답 지연(ms) — 탐지 중 취소 재현용 */
  judgeDelayMs: number;
  /** 요청 본문 기록(개인정보 누출 점검 테스트용) — 메모리에만 */
  recordBodies: boolean;
}

export function configFromEnv(e: NodeJS.ProcessEnv = process.env): StubConfig {
  return {
    health: (['ready', 'loading', 'down'].includes(e.STUB_HEALTH ?? '') ? e.STUB_HEALTH : 'ready') as StubConfig['health'],
    cold: e.STUB_COLD === 'true',
    coldDelayMs: Number(e.STUB_COLD_DELAY_MS ?? 1500),
    timeoutMatch: e.STUB_TIMEOUT_MATCH ?? '',
    timeoutDelayMs: Number(e.STUB_TIMEOUT_DELAY_MS ?? 35_000),
    apiKey: e.STUB_API_KEY ?? '',
    unknownLabel: e.STUB_UNKNOWN_LABEL === 'true',
    perspectiveDiverge: e.STUB_PERSPECTIVE_DIVERGE === 'true',
    summaryFail: e.STUB_SUMMARY_FAIL === 'true',
    judgeDelayMs: Number(e.STUB_JUDGE_DELAY_MS ?? 0),
    recordBodies: e.STUB_RECORD_BODIES === 'true',
  };
}

interface ClauseIn { clause_id: string; text: string; article_no?: string | null; title?: string | null }

const RISK_KEYWORDS: { re: RegExp; type: string; w: number; illegal?: boolean }[] = [
  { re: /위약금|손해배상.*배|3배|전액.*배상/, type: 'excessive_penalty', w: 0.45 },
  { re: /환불.*(불가|하지 않|없)|반환하지|해지.*(불가|할 수 없)|중도.*해지.*불가/, type: 'refund_cancel_limit', w: 0.5, illegal: true },
  { re: /(일방|임의|언제든지).*(변경|수정|중단)|사전 통지 없이|통지 없이/, type: 'unilateral_change', w: 0.45 },
  { re: /책임(을)? (지지|지 않|없)|면책|일체의 책임|어떠한 책임/, type: 'liability_avoid', w: 0.5, illegal: true },
  { re: /이의(를)? 제기할 수 없|소송.*제기.*없|권리.*포기|청구할 수 없/, type: 'rights_limit', w: 0.45, illegal: true },
  { re: /자동(으로)? (연장|갱신|결제)/, type: 'unilateral_change', w: 0.3 },
  { re: /기타|등 회사가 정하는|회사가 정한 바/, type: 'vague', w: 0.25 },
];

const LAW_BY_TYPE: Record<string, string> = {
  refund_cancel_limit: '전자상거래 등에서의 소비자보호에 관한 법률',
  liability_avoid: '약관의 규제에 관한 법률',
  rights_limit: '약관의 규제에 관한 법률',
  excessive_penalty: '약관의 규제에 관한 법률',
  unilateral_change: '약관의 규제에 관한 법률',
  vague: '약관의 규제에 관한 법률',
};

function h01(s: string, salt: string): number {
  const d = crypto.createHash('sha256').update(salt + '|' + s).digest();
  return d.readUInt32BE(0) / 0xffffffff;
}

export function scoreClause(text: string): { loophole: number; illegal: number; type: string | null; laws: string[] } {
  let loophole = 0.05 + h01(text, 'm1') * 0.15;
  let illegal = 0.05 + h01(text, 'm2') * 0.15;
  let type: string | null = null;
  let best = 0;
  for (const k of RISK_KEYWORDS) {
    if (k.re.test(text)) {
      loophole += k.w;
      if (k.illegal) illegal += k.w;
      if (k.w > best) {
        best = k.w;
        type = k.type;
      }
    }
  }
  const r = (x: number) => Math.round(Math.min(0.99, x) * 10000) / 10000;
  return { loophole: r(loophole), illegal: r(illegal), type, laws: type && illegal > 0.5 ? [LAW_BY_TYPE[type]!] : [] };
}

function contractTypeOf(text: string): { label: string; score: number }[] {
  const c: [string, RegExp][] = [
    ['subscription', /구독|정기\s*결제|월\s*이용료|자동\s*갱신|멤버십/],
    ['installment', /할부/],
    ['door_to_door', /방문판매|방문\s*판매|다단계/],
    ['ecommerce', /배송|주문|쇼핑몰|통신판매|청약철회/],
  ];
  const out = c.filter(([, re]) => re.test(text)).map(([label], i) => ({ label, score: Math.round((0.9 - i * 0.1) * 100) / 100 }));
  if (!out.length) out.push({ label: 'general_consumer', score: 0.6 });
  return out.slice(0, 3);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createStubApp(config: StubConfig = configFromEnv()) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const received: { path: string; body: unknown }[] = [];
  const jobs = new Map<string, { clauses: ClauseIn[]; polls: number; contractType: string }>();
  const warm = { M3: !config.cold, M4: !config.cold };
  // cold 모델을 부르는 동안은 loading 으로 보고한다(게이트웨이 동작 — model-serving §0.1)
  const loadingNow = { M3: false, M4: false };

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (config.recordBodies && req.method === 'POST') received.push({ path: req.path, body: req.body });
    if (req.path.startsWith('/__')) return next();
    const auth = req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || (config.apiKey && auth !== `Bearer ${config.apiKey}`)) {
      res.status(401).json({ detail: 'unauthorized' });
      return;
    }
    if (config.health === 'down') {
      req.socket.destroy();
      return;
    }
    next();
  });

  const modelsState = () => [
    { id: 'M1', state: config.health === 'loading' ? 'loading' : 'ready', model: 'stub-m1', size_mb: 440 },
    { id: 'M2', state: config.health === 'loading' ? 'loading' : 'ready', model: 'stub-m2', size_mb: 440 },
    // M3·M4 는 공유 채팅 모델 하나(model-serving §0) — 이름·크기가 같다
    { id: 'M3', state: config.health === 'loading' || loadingNow.M3 ? 'loading' : warm.M3 ? 'ready' : 'cold', model: 'stub-shared-chat', size_mb: 2381 },
    { id: 'M4', state: config.health === 'loading' || loadingNow.M4 ? 'loading' : warm.M4 ? 'ready' : 'cold', model: 'stub-shared-chat', size_mb: 2381 },
  ];

  app.get('/health', (_req, res) => {
    const models = modelsState();
    const cold = models.some((m) => (m.id === 'M3' || m.id === 'M4') && (m.state === 'cold' || m.state === 'loading'));
    res.status(config.health === 'loading' ? 503 : 200).json({
      status: config.health === 'loading' ? 'loading' : 'ready',
      models,
      gpu: { used_mb: 0, total_mb: 131072 },
      model_version: 'stub-bundle@1',
      knowledge_date: null,
      warmup_estimate_sec: cold ? 10 : null,
      queue_depth: 0,
    });
  });

  app.get('/v1/models', (_req, res) => {
    res.json({
      models: [
        { id: 'M1', name: 'loophole-stub', base: 'stub', model_version: 'stub-m1@1', trained_data_date: '2026-09-01' },
        { id: 'M2', name: 'illegal-stub', base: 'stub', model_version: 'stub-m2@1', trained_data_date: '2026-09-01' },
        { id: 'M3', name: 'final-judge-stub', base: 'stub', model_version: 'stub-m3@1', trained_data_date: null },
        { id: 'M4', name: 'summary-stub', base: 'stub', model_version: 'stub-m4@1', trained_data_date: null },
      ],
      model_version: 'stub-bundle@1',
      knowledge_date: null,
    });
  });

  const coldPenalty = async (id: 'M3' | 'M4') => {
    if (!warm[id]) {
      loadingNow[id] = true;
      await sleep(config.coldDelayMs);
      loadingNow[id] = false;
      warm[id] = true;
    }
  };

  app.post('/v1/summarize', async (req, res) => {
    if (config.summaryFail) return res.status(503).json({ detail: 'summary model unavailable' });
    const clauses: ClauseIn[] = req.body?.clauses ?? [];
    if (!Array.isArray(clauses) || clauses.length > 2000) return res.status(413).json({ detail: 'too many clauses' });
    await coldPenalty('M4');
    const all = clauses.map((c) => c.text).join('\n');
    const titles = clauses.map((c) => c.title).filter(Boolean).slice(0, 5).join(', ');
    res.json({
      summary: `이 문서는 ${clauses.length}개 조항으로 이루어져 있습니다.${titles ? ` 주요 조항: ${titles}.` : ''} 해지·환불과 위약금 조건을 확인할 필요가 있습니다.`,
      contract_type_candidates: contractTypeOf(all),
      model_version: 'stub-m4@1',
      knowledge_date: null,
    });
  });

  const detect = (kind: 'loophole' | 'illegal') => (req: Request, res: Response) => {
    const clauses: ClauseIn[] = req.body?.clauses ?? [];
    if (!Array.isArray(clauses) || !req.body?.contract_type) return res.status(400).json({ detail: 'clauses and contract_type required' });
    res.json({
      results: clauses.map((c) => {
        const s = scoreClause(c.text);
        return kind === 'loophole'
          ? { clause_id: c.clause_id, label: s.loophole >= 0.5 ? 'loophole' : 'none', type: s.type, score: s.loophole }
          : { clause_id: c.clause_id, label: s.illegal >= 0.5 ? 'illegal' : 'none', type: s.laws[0] ?? null, related_laws: s.laws, score: s.illegal };
      }),
      model_version: kind === 'loophole' ? 'stub-m1@1' : 'stub-m2@1',
      knowledge_date: null,
    });
  };
  app.post('/v1/detect/loophole', detect('loophole'));
  app.post('/v1/detect/illegal', detect('illegal'));

  app.post('/v1/jobs', (req, res) => {
    const clauses: ClauseIn[] = req.body?.clauses ?? [];
    if (!Array.isArray(clauses) || !req.body?.contract_type) return res.status(400).json({ detail: 'clauses and contract_type required' });
    if ('perspective' in (req.body ?? {})) return res.status(400).json({ detail: 'perspective is not accepted' });
    const id = crypto.randomUUID();
    jobs.set(id, { clauses, polls: 0, contractType: req.body.contract_type });
    // 게이트웨이는 기동 시 1회만 예열한다 — 요청마다 예열하지 않는다(가이드 1.6). cold 면 첫 /v1/judge 가 적재 시간을 낸다
    res.status(202).json({ job_id: id });
  });

  app.get('/v1/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id!);
    if (!job) return res.status(404).json({ detail: 'job not found' });
    job.polls++;
    // 폴링할 때마다 절반씩 결과를 늘린다 — 진행률 표시 검증용
    const total = job.clauses.length;
    const done = Math.min(total, Math.ceil(total * Math.min(1, job.polls / 2)));
    res.json({
      job_id: req.params.id,
      status: done >= total ? 'done' : 'running',
      total,
      done,
      results: job.clauses.slice(0, done).map((c) => {
        if (config.timeoutMatch && c.text.includes(config.timeoutMatch)) return { clause_id: c.clause_id, error: 'timeout' };
        const s = scoreClause(c.text);
        return {
          clause_id: c.clause_id,
          loophole: { label: s.loophole >= 0.5 ? 'loophole' : 'none', type: s.type, score: s.loophole },
          illegal: { label: s.illegal >= 0.5 ? 'illegal' : 'none', type: s.laws[0] ?? null, related_laws: s.laws, score: s.illegal },
          error: null,
        };
      }),
      model_versions: { M1: 'stub-m1@1', M2: 'stub-m2@1' },
      knowledge_date: null,
    });
  });

  app.post('/v1/judge', async (req, res) => {
    const b = req.body ?? {};
    if (typeof b.clause !== 'string' || !b.contract_type || !b.perspective || !b.knowledge_date || !Array.isArray(b.evidence)) {
      return res.status(400).json({ detail: 'invalid judge request' });
    }
    if (config.timeoutMatch && b.clause.includes(config.timeoutMatch)) await sleep(config.timeoutDelayMs);
    if (config.judgeDelayMs) await sleep(config.judgeDelayMs);
    await coldPenalty('M3');
    const s = scoreClause(b.clause);
    const lo = Number(b.scores?.loophole ?? s.loophole);
    const il = Number(b.scores?.illegal ?? s.illegal);
    const top = Math.max(lo, il);
    const evidence: { id: string; source_type: string; title: string }[] = b.evidence;
    const hasLaw = evidence.some((e) => e.source_type === 'law_article');
    let cls = top < 0.5 ? 'normal' : il >= 0.7 && hasLaw ? 'illegal' : top >= 0.6 ? 'unfair' : 'dispute';
    if (config.perspectiveDiverge && b.perspective === 'business') cls = cls === 'normal' ? 'dispute' : cls === 'illegal' ? 'unfair' : 'normal';
    const LABEL: Record<string, string> = { normal: '정상', dispute: '분쟁 가능', unfair: '불공정 가능', illegal: '위법 가능' };
    const level = top >= 0.85 ? '높음' : top >= 0.65 ? '중간' : '낮음';
    const conf = evidence.length >= 2 ? '높음' : evidence.length === 1 ? '중간' : '낮음';
    const ids = evidence.map((e) => String(e.id));
    const focus = b.perspective === 'business'
      ? ['이 조항은 분쟁이나 시정 요구로 이어질 위험이 있어 검토가 필요합니다', '표준약관과 비교해 소비자에게 불리한 부분을 조정하는 것을 검토할 수 있습니다']
      : ['이 조항은 소비자에게 불리하게 해석될 가능성이 있습니다', '관련 규정에 비추어 효력이 문제될 수 있어 확인이 필요합니다'];
    const explanation = cls === 'normal' || !ids.length ? [] : focus.slice(0, Math.min(2, ids.length)).map((claim, i) => ({ claim, evidence_ids: [ids[i]!] }));
    res.json({
      risk_class: config.unknownLabel ? '알 수 없음' : LABEL[cls],
      risk_type: cls === 'normal' ? null : (s.type ?? 'other'),
      risk_level: cls === 'normal' ? null : level,
      confidence: cls === 'normal' ? null : conf,
      explanation,
      model_version: 'stub-m3@1',
      knowledge_date: b.knowledge_date,
    });
  });

  app.get('/openapi.json', (_req, res) => res.json({ openapi: '3.0.3', info: { title: 'model-api-stub', version: '1' }, paths: {} }));

  return { app, config, received, jobs, warm };
}
