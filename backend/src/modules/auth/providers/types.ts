export type ProviderId = 'kakao' | 'naver' | 'dev';

export interface ProviderProfile {
  /** 제공자 사용자 고유 번호 — auth_identity.provider_subject */
  subject: string;
  /** 세션에만 둔다(FR-043) */
  nickname: string | null;
}

export interface OAuthProvider {
  id: ProviderId;
  enabled(): boolean;
  authorizeUrl(state: string, redirectUri: string, req: { query: Record<string, unknown> }): string;
  /** 인가 코드 교환 후 식별자·닉네임만 조회한다. 토큰은 반환하지도 저장하지도 않는다 */
  exchange(code: string, state: string, redirectUri: string): Promise<ProviderProfile>;
}

export async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`oauth_http_${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}
