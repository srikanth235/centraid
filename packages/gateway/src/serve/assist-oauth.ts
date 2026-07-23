/**
 * Host-injected Centraid Assist OAuth configuration (issue #526).
 *
 * The gateway core never reads process.env. Desktop/daemon hosts may pass
 * public deployment coordinates through this shape; the Google client
 * secret and callback-receipt HMAC secret exist only as Cloudflare Worker
 * secret bindings and are deliberately absent here.
 */

export const ASSIST_GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ASSIST_GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ASSIST_PRODUCTION_WORKER_ORIGIN = 'https://oauth.centraid.dev';
export const ASSIST_PRODUCTION_CALLBACK_URL = `${ASSIST_PRODUCTION_WORKER_ORIGIN}/callback`;
export const ASSIST_DEVELOPMENT_WORKER_ORIGIN = 'http://127.0.0.1:8787';

export const GOOGLE_ASSIST_SCOPE_TIERS = Object.freeze({
  standard: Object.freeze([
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
  ]),
  restricted: Object.freeze([
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/drive.readonly',
  ]),
});

export interface AssistOAuthConfig {
  /** Worker origin only; paths are fixed by the protocol. */
  readonly workerBaseUrl: string;
  /** Public Google OAuth Web client id. Never a secret. */
  readonly googleClientId: string;
  /** Release gate: restricted scopes stay unavailable until verification. */
  readonly restrictedScopesEnabled: boolean;
}

export interface AssistOAuthEnvironment {
  readonly CENTRAID_ASSIST_OAUTH_WORKER_URL?: string;
  readonly CENTRAID_ASSIST_GOOGLE_CLIENT_ID?: string;
  readonly CENTRAID_ASSIST_RESTRICTED_SCOPES?: string;
}

/**
 * Parse the two public host settings. Both are required so half-configured
 * deployments fail closed and do not advertise Assist.
 */
export function assistOAuthFromEnvironment(
  environment: AssistOAuthEnvironment,
): AssistOAuthConfig | undefined {
  const workerBaseUrl = environment.CENTRAID_ASSIST_OAUTH_WORKER_URL?.trim();
  const googleClientId = environment.CENTRAID_ASSIST_GOOGLE_CLIENT_ID?.trim();
  if (!workerBaseUrl && !googleClientId) return undefined;
  if (!workerBaseUrl || !googleClientId) {
    throw new Error(
      'Centraid Assist requires both CENTRAID_ASSIST_OAUTH_WORKER_URL and CENTRAID_ASSIST_GOOGLE_CLIENT_ID',
    );
  }
  const restricted = environment.CENTRAID_ASSIST_RESTRICTED_SCOPES?.trim().toLowerCase();
  if (restricted !== undefined && !['1', 'true', '0', 'false'].includes(restricted)) {
    throw new Error('CENTRAID_ASSIST_RESTRICTED_SCOPES must be true/false or 1/0');
  }
  return validateAssistOAuthConfig({
    workerBaseUrl,
    googleClientId,
    restrictedScopesEnabled: restricted === '1' || restricted === 'true',
  });
}

export function validateAssistOAuthConfig(config: AssistOAuthConfig): AssistOAuthConfig {
  const worker = new URL(config.workerBaseUrl);
  if (worker.username || worker.password || worker.search || worker.hash) {
    throw new Error('Centraid Assist Worker URL must be a bare origin without credentials/query');
  }
  if (worker.pathname !== '/' && worker.pathname !== '') {
    throw new Error('Centraid Assist Worker URL must not contain a path');
  }
  if (
    worker.origin !== ASSIST_PRODUCTION_WORKER_ORIGIN &&
    worker.origin !== ASSIST_DEVELOPMENT_WORKER_ORIGIN
  ) {
    throw new Error(
      `Centraid Assist Worker must be ${ASSIST_PRODUCTION_WORKER_ORIGIN} or the exact local-development origin ${ASSIST_DEVELOPMENT_WORKER_ORIGIN}`,
    );
  }
  if (!/^[A-Za-z0-9._-]{8,256}\.apps\.googleusercontent\.com$/.test(config.googleClientId)) {
    throw new Error('Centraid Assist Google client id is not a valid Web client id');
  }
  return Object.freeze({
    workerBaseUrl: worker.origin,
    googleClientId: config.googleClientId,
    restrictedScopesEnabled: config.restrictedScopesEnabled === true,
  });
}

export function assistCallbackUrl(config: AssistOAuthConfig): string {
  return new URL('/callback', `${config.workerBaseUrl}/`).toString();
}

export function assistScopes(
  requested: readonly string[],
  config: AssistOAuthConfig,
): readonly string[] {
  const standard = new Set<string>(GOOGLE_ASSIST_SCOPE_TIERS.standard);
  const restricted = new Set<string>(GOOGLE_ASSIST_SCOPE_TIERS.restricted);
  const allowed = new Set(standard);
  if (config.restrictedScopesEnabled) {
    for (const scope of restricted) allowed.add(scope);
  }
  const unique = [...new Set(requested)];
  const known = new Set([...standard, ...restricted]);
  if (unique.length === 0 || unique.some((scope) => !known.has(scope))) {
    throw new Error('requested Google scope is not part of a Centraid Assist tier');
  }
  if (!config.restrictedScopesEnabled && unique.some((scope) => restricted.has(scope))) {
    throw new Error(
      'restricted Google scopes are unavailable until OAuth verification is complete',
    );
  }
  return unique;
}
