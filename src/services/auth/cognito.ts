import { isDemoMode } from '../../config/runtime';

export interface OperatorUser {
  id: string;
  email: string;
  name: string;
  role: 'operator_admin' | 'field_inspector' | 'guest_demo';
  isDemoAccount: boolean;
}

interface CognitoTokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface JwtClaims {
  sub?: string;
  email?: string;
  name?: string;
  exp?: number;
  'cognito:groups'?: string[];
}

export interface CognitoAuthOptions {
  clientId?: string;
  domain?: string;
  demoMode?: boolean;
  fetchImpl?: typeof fetch;
}

const ACCESS_TOKEN_KEY = 'ezpath_cognito_access_token';
const ID_TOKEN_KEY = 'ezpath_cognito_id_token';
const REFRESH_TOKEN_KEY = 'ezpath_cognito_refresh_token';
const PKCE_VERIFIER_KEY = 'ezpath_pkce_verifier';
const OAUTH_STATE_KEY = 'ezpath_oauth_state';

const DEMO_OPERATOR_USER: OperatorUser = {
  id: 'op_demo_01',
  email: 'operator@ezpath.demo',
  name: 'Central Control Operator (Demo)',
  role: 'operator_admin',
  isDemoAccount: true,
};

const SIGN_IN_REQUIRED_USER: OperatorUser = {
  id: 'operator-sign-in-required',
  email: '',
  name: 'Operator sign-in required',
  role: 'guest_demo',
  isDemoAccount: true,
};

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function decodeJwt(token: string | null): JwtClaims | null {
  if (!token) return null;
  const encoded = token.split('.')[1];
  if (!encoded) return null;
  try {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      Math.ceil(encoded.length / 4) * 4,
      '=',
    );
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as JwtClaims;
  } catch {
    return null;
  }
}

function tokenIsCurrent(token: string | null): boolean {
  const claims = decodeJwt(token);
  return Boolean(claims?.exp && claims.exp * 1000 > Date.now() + 30_000);
}

export class CognitoAuthService {
  private readonly clientId: string;
  private readonly domain: string;
  private readonly demoMode: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CognitoAuthOptions = {}) {
    this.clientId = options.clientId ?? import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';
    this.domain = (options.domain ?? import.meta.env.VITE_COGNITO_DOMAIN ?? '').replace(/\/+$/, '');
    this.demoMode = options.demoMode ?? isDemoMode;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  getCurrentUser(): OperatorUser {
    if (this.demoMode) return DEMO_OPERATOR_USER;
    if (!this.isAuthenticated()) return SIGN_IN_REQUIRED_USER;

    const claims = decodeJwt(localStorage.getItem(ID_TOKEN_KEY));
    const groups = claims?.['cognito:groups'] ?? [];
    const role = groups.includes('field_inspector') ? 'field_inspector' : 'operator_admin';
    return {
      id: claims?.sub ?? 'cognito-operator',
      email: claims?.email ?? '',
      name: claims?.name || claims?.email || 'EzPath operator',
      role,
      isDemoAccount: false,
    };
  }

  isAuthenticated(): boolean {
    return this.demoMode || tokenIsCurrent(localStorage.getItem(ACCESS_TOKEN_KEY));
  }

  getAccessToken(): string | null {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    return tokenIsCurrent(token) ? token : null;
  }

  private requireConfiguration(): void {
    if (!this.clientId || !this.domain) {
      throw new Error('Cognito operator login is not configured for this deployment.');
    }
  }

  async buildSignInUrl(): Promise<string> {
    this.requireConfiguration();
    const verifier = randomBase64Url(64);
    const state = randomBase64Url(32);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(OAUTH_STATE_KEY, state);

    const parameters = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: `${window.location.origin}/operator/callback`,
      state,
      code_challenge_method: 'S256',
      code_challenge: await codeChallenge(verifier),
    });
    return `${this.domain}/oauth2/authorize?${parameters.toString()}`;
  }

  async beginSignIn(): Promise<void> {
    window.location.assign(await this.buildSignInUrl());
  }

  async completeSignIn(search = window.location.search): Promise<OperatorUser> {
    this.requireConfiguration();
    const parameters = new URLSearchParams(search);
    const oauthError = parameters.get('error_description') || parameters.get('error');
    if (oauthError) throw new Error(oauthError);

    const code = parameters.get('code');
    const returnedState = parameters.get('state');
    const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    if (!code || !returnedState || !expectedState || returnedState !== expectedState || !verifier) {
      throw new Error('The Cognito sign-in response could not be verified. Start sign-in again.');
    }

    const response = await this.fetchImpl(`${this.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        code,
        redirect_uri: `${window.location.origin}/operator/callback`,
        code_verifier: verifier,
      }),
    });
    const payload = (await response.json()) as CognitoTokenResponse;
    if (!response.ok || !payload.access_token || !payload.id_token) {
      throw new Error(payload.error_description || payload.error || 'Cognito token exchange failed.');
    }

    localStorage.setItem(ACCESS_TOKEN_KEY, payload.access_token);
    localStorage.setItem(ID_TOKEN_KEY, payload.id_token);
    if (payload.refresh_token) localStorage.setItem(REFRESH_TOKEN_KEY, payload.refresh_token);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    sessionStorage.removeItem(OAUTH_STATE_KEY);
    localStorage.removeItem('accesspath_cognito_token');
    return this.getCurrentUser();
  }

  signInDemo(): OperatorUser {
    return DEMO_OPERATOR_USER;
  }

  signOut(redirectToCognito = false): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(ID_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem('accesspath_cognito_token');
    if (redirectToCognito && !this.demoMode && this.clientId && this.domain) {
      const parameters = new URLSearchParams({
        client_id: this.clientId,
        logout_uri: `${window.location.origin}/operator`,
      });
      window.location.assign(`${this.domain}/logout?${parameters.toString()}`);
    }
  }

  getCredentialsInfo() {
    return {
      clientId: this.clientId,
      isConfigured: Boolean(this.clientId && this.domain),
      modeNotice: this.demoMode
        ? 'Running in operator demo mode.'
        : 'Production operator access uses Cognito Managed Login with PKCE and required MFA.',
    };
  }
}

export const authService = new CognitoAuthService();
