import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitoAuthService } from '../src/services/auth/cognito';

function token(claims: Record<string, unknown>): string {
  const encode = (value: object) => btoa(JSON.stringify(value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`;
}

describe('CognitoAuthService', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('uses OAuth authorization code with PKCE', async () => {
    const service = new CognitoAuthService({
      clientId: 'operator-client',
      domain: 'https://operators.auth.ap-south-1.amazoncognito.com',
      demoMode: false,
    });

    const url = new URL(await service.buildSignInUrl());

    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('exchanges a verified callback and exposes only a current access token', async () => {
    const accessToken = token({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const idToken = token({
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'operator-1',
      email: 'operator@example.test',
      name: 'Campus Operator',
    });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ access_token: accessToken, id_token: idToken }),
    } as Response));
    const service = new CognitoAuthService({
      clientId: 'operator-client',
      domain: 'https://operators.auth.ap-south-1.amazoncognito.com',
      demoMode: false,
      fetchImpl: fetchImpl as typeof fetch,
    });
    const authorizationUrl = new URL(await service.buildSignInUrl());
    const state = authorizationUrl.searchParams.get('state');

    const user = await service.completeSignIn(`?code=authorization-code&state=${state}`);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.isAuthenticated()).toBe(true);
    expect(service.getAccessToken()).toBe(accessToken);
    expect(user).toMatchObject({
      id: 'operator-1',
      email: 'operator@example.test',
      name: 'Campus Operator',
      isDemoAccount: false,
    });
  });

  it('rejects callbacks whose state does not match the initiated login', async () => {
    const service = new CognitoAuthService({
      clientId: 'operator-client',
      domain: 'https://operators.auth.ap-south-1.amazoncognito.com',
      demoMode: false,
    });
    await service.buildSignInUrl();

    await expect(service.completeSignIn('?code=authorization-code&state=wrong')).rejects.toThrow(
      'could not be verified',
    );
  });

  it('calls the browser fetch function without rebinding its receiver', async () => {
    const accessToken = token({ exp: Math.floor(Date.now() / 1000) + 3600 });
    const idToken = token({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'operator-2' });
    const browserFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: accessToken, id_token: idToken }),
    } as Response);
    const service = new CognitoAuthService({
      clientId: 'operator-client',
      domain: 'https://operators.auth.ap-south-1.amazoncognito.com',
      demoMode: false,
    });
    const authorizationUrl = new URL(await service.buildSignInUrl());

    await service.completeSignIn(
      `?code=authorization-code&state=${authorizationUrl.searchParams.get('state')}`,
    );

    expect(browserFetch).toHaveBeenCalledTimes(1);
    browserFetch.mockRestore();
  });
});
