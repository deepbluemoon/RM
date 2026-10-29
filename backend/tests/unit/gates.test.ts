// T043 — G0~G14 마다 문구 사전 항목이 있고 제목이 gate_def.title_text(001 INSERT) 와 같다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GATE_MESSAGES } from '../../src/modules/gates/messages.js';
import { GateError, GATE_HTTP_STATUS } from '../../src/modules/gates/GateError.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ddl = fs.readFileSync(path.resolve(here, '..', '..', 'db', 'migrations', '001_crd_ddl.sql'), 'utf8');
const titles = new Map<string, string>();
for (const m of ddl.matchAll(/SELECT '(G\d+)'(?: AS g)?, '[^']*'(?: AS n)?, '[^']*'(?: AS p)?, '[^']*'(?: AS sc)?, '[^']*'(?: AS a)?, '([^']*)'/g)) titles.set(m[1]!, m[2]!);

describe('게이트 문구 사전', () => {
  it('gate_def 15개를 모두 읽었다', () => expect(titles.size).toBe(15));
  for (let i = 0; i <= 14; i++) {
    const g = `G${i}` as keyof typeof GATE_MESSAGES;
    it(`${g} 제목이 gate_def 와 같다`, () => {
      expect(GATE_MESSAGES[g]).toBeDefined();
      expect(GATE_MESSAGES[g].title).toBe(titles.get(g));
    });
  }
  it('HTTP 상태 사상 (G8·G14→403, G2·G3·G6→422, G4→429, G5→503)', () => {
    expect([GATE_HTTP_STATUS.G8, GATE_HTTP_STATUS.G14]).toEqual([403, 403]);
    expect([GATE_HTTP_STATUS.G2, GATE_HTTP_STATUS.G3, GATE_HTTP_STATUS.G6]).toEqual([422, 422, 422]);
    expect(GATE_HTTP_STATUS.G4).toBe(429);
    expect(GATE_HTTP_STATUS.G5).toBe(503);
  });
  it('GateError 본문은 계약 필수 필드를 가진다', () => {
    const e = new GateError('G4', { params: { limit: 3, resetMd: '10-01' } });
    expect(e.body).toMatchObject({ gate: 'G4', title: '이번 달 무료 분석을 모두 사용했습니다', releaseActor: 'system', releaseText: '시스템 - 10-01 초기화' });
    expect(e.body.reason).toContain('3건');
  });
});
