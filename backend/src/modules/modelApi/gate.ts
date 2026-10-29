// 1.6 / 4.5 / 6.5 모델 서버 가용 확인 — G5 판정 지점. cold(유휴 언로드)는 호출 가능하므로 막지 않는다
import { raise, type GateSubject } from '../gates/gates.service.js';
import { getServerStatus } from './status.js';

export async function assertModelServerReady(subject: GateSubject): Promise<void> {
  const s = await getServerStatus(true);
  if (s.state === 'ready') return;
  await raise('G5', s.state === 'loading' ? 'model_loading' : 'model_unreachable', subject, {
    params: { state: s.state === 'loading' ? '모델을 불러오는 중' : '응답하지 않음' },
    detail: { serverState: s.state, checkedAt: s.checkedAt },
  });
}
