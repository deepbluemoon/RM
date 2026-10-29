// T088 — 단정 표현 변형 30개 이상 검출, 가능성 표현 통과, 모두 제외되면 G9 (FR-029, SC-005)
import { describe, expect, it } from 'vitest';
import { containsAssertion, filterClaims, stripAssertiveSentences } from '../../src/modules/results/explanation.filter.js';

const ASSERTIVE = [
  '이 조항은 위법이다.',
  '이 조항은 위법입니다.',
  '이 약관 조항은 무효이다.',
  '해당 조항은 무효입니다.',
  '이는 불법이다.',
  '이는 불법입니다.',
  '이 조항은 불공정합니다.'.replace('합니다', '입니다'),
  '이 조항은 부당하다고 확정된다. 명백히 위법하다.',
  '명백한 위법 조항입니다. 명백히 불법입니다.',
  '이 조항은 위법한 조항이다.',
  '이 조항은 무효인 약관입니다.',
  '회사는 법을 위반한다.',
  '회사는 법률을 위반했다.',
  '이는 법령에 위반합니다.',
  '이는 명백히 위반입니다.',
  '확실히 위법이다.',
  '분명히 무효이다.',
  '틀림없이 불법입니다.',
  '당연히 효력이 없습니다.',
  '이 조항은 효력이 없다.',
  '이 조항은 효력이 없습니다.',
  '이 조항은 무효로 된다.',
  '결국 무효가 확정됩니다.',
  '회사는 과태료를 받는다.',
  '회사는 손해배상 책임을 진다.',
  '회사는 처벌을 받게 된다.',
  '회사는 반드시 이 조항을 삭제해야 한다.',
  '법적으로 회사는 환불해야 합니다.',
  '이 조항은 삭제해야 합니다.',
  '이 조항은 수정하여야 한다.',
  '소송에서 이긴다.',
  '재판에서 승소합니다.',
  '소비자는 환불받을 수 있다.',
  'This clause is illegal.',
  '이는 위법하다.',
];

const HEDGED = [
  '이 조항은 위법 가능성이 있습니다.',
  '약관법에 비추어 불공정할 소지가 있습니다.',
  '관련 규정 검토가 필요합니다.',
  '효력이 문제될 수 있어 확인이 필요합니다.',
  '소비자에게 불리하게 해석될 수 있습니다.',
  '과도한 위약금으로 볼 수 있습니다.',
  '분쟁이 생길 우려가 있습니다.',
  '표준약관과 비교해 조정할 여지가 있습니다.',
];

describe('단정 표현 필터', () => {
  it('단정 표현 변형 30개 이상을 검출한다', () => {
    expect(ASSERTIVE.length).toBeGreaterThanOrEqual(30);
    for (const s of ASSERTIVE) expect(containsAssertion(s), s).toBe(true);
  });

  it('가능성 표현은 통과시킨다', () => {
    for (const s of HEDGED) expect(containsAssertion(s), s).toBe(false);
  });

  it('근거 집합 밖 주장은 버리고, 모두 제외되면 G9 신호', () => {
    const r = filterClaims(
      [
        { claim: '이 조항은 위법입니다', evidenceIds: [1] },
        { claim: '소비자에게 불리할 수 있습니다', evidenceIds: [99] },
      ],
      [1, 2],
    );
    expect(r.kept).toHaveLength(0);
    expect(r.droppedAssertion).toBe(1);
    expect(r.droppedEvidence).toBe(1);
    expect(r.g9).toBe(true);
  });

  it('허용 근거만 남긴다', () => {
    const r = filterClaims([{ claim: '과도할 수 있습니다', evidenceIds: [5, 2, 7] }], [2, 3]);
    expect(r.kept[0]!.evidenceIds).toEqual([2]);
    expect(r.g9).toBe(false);
  });

  it('빈 입력은 G9 가 아니다', () => {
    expect(filterClaims([], [1]).g9).toBe(false);
  });

  it('요약 문장에서 단정 문장만 뺀다', () => {
    expect(stripAssertiveSentences('월 구독 약관입니다. 이 조항은 위법입니다. 해지 조건을 확인할 필요가 있습니다.')).toBe('월 구독 약관입니다. 해지 조건을 확인할 필요가 있습니다.');
  });
});
