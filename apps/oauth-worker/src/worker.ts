/**
 * Centraid Assist OAuth courier (issue #526, Model B).
 *
 * Stateless by construction: no KV, D1, Durable Object, or cache. The only
 * cookie is a signed, short-lived browser-binding envelope with no OAuth
 * material or identity. Google secrets are Worker bindings; authorization
 * codes and refresh tokens exist only in request memory and are never logged.
 */
// governance: allow-repo-hygiene file-size-limit #526 Keep the reviewed security boundary cohesive.

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PUBLIC_ORIGIN = 'https://oauth.centraid.dev';
const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:8787';
const APP_ORIGIN = 'https://app.centraid.dev';
const CALLBACK_URL = `${PUBLIC_ORIGIN}/callback`;
const RECEIPT_TTL_SECONDS = 120;
const BROWSER_BINDING_TTL_SECONDS = 10 * 60;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_GOOGLE_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_BROWSER_ORIGINS = new Set(['https://app.centraid.dev', 'centraid://']);
const PRODUCTION_BINDING_COOKIE_PREFIX = '__Host-centraid-oauth-binding-';
const DEVELOPMENT_BINDING_COOKIE_PREFIX = 'centraid-oauth-binding-';
const STANDARD_GOOGLE_SCOPES = new Set([
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
]);
const RESTRICTED_GOOGLE_SCOPES = new Set([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.readonly',
]);

interface PreparedGrant {
  form: URLSearchParams;
  expectedScopes?: readonly string[];
}

interface WorkerDependencies {
  fetch: typeof fetch;
  now: () => number;
}

const defaultDependencies: WorkerDependencies = {
  fetch,
  now: () => Date.now(),
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx, defaultDependencies);
  },
} satisfies ExportedHandler<Env>;

export async function handleRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  dependencies: WorkerDependencies = defaultDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== PUBLIC_ORIGIN && url.origin !== DEVELOPMENT_ORIGIN) {
    return responseJson(421, { error: 'invalid_origin' });
  }
  if (!validEnvironment(env, url)) {
    return responseJson(503, { error: 'configuration_error' });
  }
  if (request.method === 'OPTIONS') return corsPreflight(request);
  if (url.pathname === '/start' && request.method === 'GET') {
    return startPage(env);
  }
  if (url.pathname === '/bind' && request.method === 'POST') {
    return bindBrowser(request, env, dependencies.now());
  }
  if (url.pathname === '/callback' && request.method === 'GET') {
    return callbackResponse(request, url, env, dependencies.now());
  }
  if (url.pathname === '/exchange' && request.method === 'POST') {
    return tokenProxy('exchange', request, env, dependencies);
  }
  if (url.pathname === '/refresh' && request.method === 'POST') {
    return tokenProxy('refresh', request, env, dependencies);
  }
  return responseJson(404, { error: 'not_found' });
}

async function callbackResponse(
  request: Request,
  url: URL,
  env: Env,
  now: number,
): Promise<Response> {
  const limited = await enforceRateLimit('callback', request, env);
  if (limited) return limited;
  const state = bounded(url.searchParams.get('state'), 128);
  if (!state || !/^[dw]\.[A-Za-z0-9_-]{43}$/.test(state)) {
    metric(env, 'callback', 'invalid_state', 400);
    return finishPage(400, 'Not connected', 'The authorization return was incomplete.');
  }
  const binding = await readBrowserBinding(request, state, env.CALLBACK_RECEIPT_SECRET, now);
  if (!binding) {
    metric(env, 'callback', 'invalid_browser_binding', 400);
    return finishPage(
      400,
      'Not connected',
      'This return did not come from the browser that started the Centraid connection.',
    );
  }
  const providerError = bounded(url.searchParams.get('error'), 128);
  const code = bounded(url.searchParams.get('code'), 4096);
  let fragment: URLSearchParams;
  if (providerError || !code) {
    fragment = new URLSearchParams({
      state,
      error: providerError === 'access_denied' ? 'access_denied' : 'provider_error',
    });
    metric(env, 'callback', providerError === 'access_denied' ? 'denied' : 'invalid_code', 400);
  } else {
    const receipt = await mintReceipt(
      code,
      state,
      binding.bindingHash,
      env.CALLBACK_RECEIPT_SECRET,
      now,
    );
    fragment = new URLSearchParams({ code, state, receipt });
    metric(env, 'callback', 'success', 200);
  }
  if (state.startsWith('w.')) {
    const destination = new URL('/oauth/finish', env.APP_ORIGIN);
    destination.hash = fragment.toString();
    return clearBrowserBinding(
      withSecurityHeaders(
        new Response(null, {
          status: 303,
          headers: { location: destination.toString() },
        }),
      ),
      url,
      state,
    );
  }
  const deepLink = `centraid://oauth/finish#${fragment.toString()}`;
  return clearBrowserBinding(
    desktopFinishPage(
      deepLink,
      code ? 'Return to Centraid to finish connecting.' : 'Return to Centraid and try again.',
    ),
    url,
    state,
  );
}

/**
 * The gateway returns this page as the browser entry point. Its fragment
 * carries a one-ceremony binding that is absent from Google's authorization
 * URL. The page scrubs the fragment before I/O, seals the binding into an
 * HttpOnly same-site cookie, then navigates to the validated Google URL.
 */
function startPage(env: Env): Response {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const clientId = JSON.stringify(env.GOOGLE_CLIENT_ID).replace(/</g, '\\u003c');
  const callbackUrl = JSON.stringify(env.CALLBACK_URL).replace(/</g, '\\u003c');
  const allowedScopes = JSON.stringify([
    ...STANDARD_GOOGLE_SCOPES,
    ...(String(env.RESTRICTED_SCOPES_ENABLED) === 'true' ? RESTRICTED_GOOGLE_SCOPES : []),
  ]).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Continue to Google</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:1.5rem;line-height:1.5;color:#17202a}</style>
<main><h1>Continue to Google</h1><p id="status">Securing this connection…</p></main>
<script nonce="${nonce}">
const raw=location.hash.slice(1);history.replaceState(null,'',location.pathname);
const params=new URLSearchParams(raw);const target=params.get('authorization_url');const binding=params.get('browser_binding');
const fail=()=>{document.getElementById('status').textContent='This connection link is invalid or expired. Return to Centraid and start again.'};
try{
  const url=new URL(target||'');
  const allowedScopes=new Set(${allowedScopes});const scopes=(url.searchParams.get('scope')||'').split(/\\s+/).filter(Boolean);
  const allowedParams=new Set(['client_id','redirect_uri','response_type','scope','code_challenge','code_challenge_method','state','access_type','prompt','login_hint']);
  const valid=url.origin==='https://accounts.google.com'&&url.pathname==='/o/oauth2/v2/auth'&&
    !url.username&&!url.password&&!url.hash&&(target||'').length<=8192&&
    url.searchParams.get('client_id')===${clientId}&&url.searchParams.get('redirect_uri')===${callbackUrl}&&
    url.searchParams.get('response_type')==='code'&&url.searchParams.get('code_challenge_method')==='S256'&&
    url.searchParams.get('access_type')==='offline'&&url.searchParams.get('prompt')==='consent'&&
    /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge')||'')&&
    /^[dw]\\.[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state')||'')&&
    /^[A-Za-z0-9_-]{43}$/.test(binding||'')&&scopes.length>0&&new Set(scopes).size===scopes.length&&
    scopes.every(scope=>allowedScopes.has(scope))&&[...url.searchParams.keys()].every(key=>allowedParams.has(key));
  if(!valid)throw new Error('invalid');
  fetch('/bind',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},
    body:JSON.stringify({state:url.searchParams.get('state'),browser_binding:binding})})
    .then(response=>{if(!response.ok)throw new Error('bind');location.replace(url.toString())}).catch(fail);
}catch{fail()}
</script></html>`;
  return withSecurityHeaders(
    new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    }),
  );
}

async function bindBrowser(request: Request, env: Env, now: number): Promise<Response> {
  const limited = await enforceRateLimit('bind', request, env);
  if (limited) return limited;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    metric(env, 'bind', 'invalid_content_type', 415);
    return responseJson(415, { error: 'content_type_required' });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, MAX_JSON_BODY_BYTES);
  } catch {
    metric(env, 'bind', 'invalid_body', 400);
    return responseJson(400, { error: 'invalid_body' });
  }
  const state = bounded(body.state, 128);
  const browserBinding = bounded(body.browser_binding, 128);
  if (
    !state ||
    !/^[dw]\.[A-Za-z0-9_-]{43}$/.test(state) ||
    !browserBinding ||
    !/^[A-Za-z0-9_-]{43}$/.test(browserBinding)
  ) {
    metric(env, 'bind', 'invalid_body', 400);
    return responseJson(400, { error: 'invalid_body' });
  }
  const cookie = await mintBrowserBinding(state, browserBinding, env.CALLBACK_RECEIPT_SECRET, now);
  metric(env, 'bind', 'success', 204);
  return withSecurityHeaders(
    new Response(null, {
      status: 204,
      headers: {
        'set-cookie': serializeBrowserBindingCookie(new URL(request.url), state, cookie),
      },
    }),
  );
}

async function mintBrowserBinding(
  state: string,
  browserBinding: string,
  secret: string,
  now: number,
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + BROWSER_BINDING_TTL_SECONDS;
  const bindingHash = await sha256(browserBinding);
  const payload = `v1.${expiresAt}.${state}.${bindingHash}`;
  const mac = await hmac(`browser-binding\n${payload}`, secret);
  return `${payload}.${mac}`;
}

async function readBrowserBinding(
  request: Request,
  expectedState: string,
  secret: string,
  now: number,
): Promise<{ bindingHash: string } | undefined> {
  const cookie = request.headers.get('cookie');
  const name = browserBindingCookieName(new URL(request.url), expectedState);
  const value = cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) return undefined;
  const match =
    /^v1\.(\d{10})\.([dw]\.[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(
      value,
    );
  if (!match || match[2] !== expectedState) return undefined;
  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt < nowSeconds || expiresAt > nowSeconds + BROWSER_BINDING_TTL_SECONDS) {
    return undefined;
  }
  const payload = `v1.${match[1]}.${match[2]}.${match[3]}`;
  if (!(await verifyHmac(`browser-binding\n${payload}`, match[4]!, secret))) return undefined;
  return { bindingHash: match[3]! };
}

function serializeBrowserBindingCookie(url: URL, state: string, value: string): string {
  const secure = url.origin === PUBLIC_ORIGIN;
  return `${browserBindingCookieName(url, state)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${BROWSER_BINDING_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}

function clearBrowserBinding(response: Response, url: URL, state: string): Response {
  const headers = new Headers(response.headers);
  headers.append(
    'set-cookie',
    `${browserBindingCookieName(url, state)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.origin === PUBLIC_ORIGIN ? '; Secure' : ''}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function browserBindingCookieName(url: URL, state: string): string {
  const prefix =
    url.origin === PUBLIC_ORIGIN
      ? PRODUCTION_BINDING_COOKIE_PREFIX
      : DEVELOPMENT_BINDING_COOKIE_PREFIX;
  return `${prefix}${state}`;
}

async function tokenProxy(
  route: 'exchange' | 'refresh',
  request: Request,
  env: Env,
  dependencies: WorkerDependencies,
): Promise<Response> {
  if (env.EXCHANGE_ENABLED !== 'true') {
    metric(env, route, 'disabled', 503);
    return responseJson(503, { error: 'assist_disabled' });
  }
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    metric(env, route, 'invalid_content_type', 415);
    return responseJson(415, { error: 'content_type_required' });
  }
  const limited = await enforceRateLimit(route, request, env);
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(request, MAX_JSON_BODY_BYTES);
  } catch {
    metric(env, route, 'invalid_body', 400);
    return responseJson(400, { error: 'invalid_body' });
  }
  const grant =
    route === 'exchange'
      ? await exchangeForm(body, env, dependencies.now())
      : refreshForm(body, env);
  if ('error' in grant) {
    metric(env, route, grant.error, 400);
    return responseJson(400, grant);
  }
  let upstream: Response;
  try {
    upstream = await dependencies.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: grant.form.toString(),
      redirect: 'error',
    });
  } catch {
    metric(env, route, 'upstream_unavailable', 503);
    return responseJson(503, { error: 'upstream_unavailable' });
  }
  let text: string;
  try {
    text = await readBoundedText(upstream, MAX_GOOGLE_RESPONSE_BYTES);
  } catch {
    metric(env, route, 'invalid_upstream_response', 502);
    return responseJson(502, { error: 'invalid_upstream_response' });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    metric(env, route, 'invalid_upstream_response', 502);
    return responseJson(502, { error: 'invalid_upstream_response' });
  }
  if (!upstream.ok) {
    const upstreamCode = safeOAuthError(payload.error);
    const transient = upstream.status === 429 || upstream.status >= 500;
    const status = transient ? 503 : 400;
    metric(env, route, upstreamCode, status);
    return responseJson(status, { error: upstreamCode });
  }
  if (
    route === 'exchange' &&
    (!grant.expectedScopes || !sameScopes(payload.scope, grant.expectedScopes))
  ) {
    metric(env, route, 'unexpected_scope', 502);
    return responseJson(502, { error: 'invalid_upstream_response' });
  }
  const accessToken = bounded(payload.access_token, 16 * 1024);
  if (!accessToken) {
    metric(env, route, 'invalid_upstream_response', 502);
    return responseJson(502, { error: 'invalid_upstream_response' });
  }
  const result: Record<string, unknown> = {
    access_token: accessToken,
    token_type: payload.token_type === 'Bearer' ? 'Bearer' : 'Bearer',
  };
  const refreshToken = bounded(payload.refresh_token, 16 * 1024);
  if (refreshToken) result.refresh_token = refreshToken;
  if (
    typeof payload.expires_in === 'number' &&
    Number.isFinite(payload.expires_in) &&
    payload.expires_in > 0 &&
    payload.expires_in <= 86_400
  ) {
    result.expires_in = payload.expires_in;
  }
  if (typeof payload.scope === 'string' && payload.scope.length <= 4096) {
    result.scope = payload.scope;
  }
  metric(env, route, 'success', 200);
  return responseJson(200, result);
}

async function enforceRateLimit(
  route: 'bind' | 'callback' | 'exchange' | 'refresh',
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'development';
  let ipLimit: { success: boolean };
  let globalLimit: { success: boolean };
  try {
    [ipLimit, globalLimit] = await Promise.all([
      env.IP_LIMITER.limit({ key: `${route}:${ip}` }),
      env.GLOBAL_LIMITER.limit({ key: route }),
    ]);
  } catch {
    metric(env, route, 'rate_limiter_unavailable', 503);
    return responseJson(503, { error: 'rate_limiter_unavailable' });
  }
  if (!ipLimit.success || !globalLimit.success) {
    metric(env, route, 'rate_limited', 429);
    return responseJson(429, { error: 'rate_limited' }, { 'retry-after': '60' });
  }
  return undefined;
}

async function exchangeForm(
  body: Record<string, unknown>,
  env: Env,
  now: number,
): Promise<PreparedGrant | { error: string }> {
  if (body.provider !== 'google') return { error: 'unsupported_provider' };
  const code = bounded(body.code, 4096);
  const verifier = bounded(body.code_verifier, 128);
  const redirectUri = bounded(body.redirect_uri, 512);
  const receipt = bounded(body.receipt, 1024);
  const state = bounded(body.state, 128);
  const browserBinding = bounded(body.browser_binding, 128);
  const scopes = validatedScopes(body.scopes, String(env.RESTRICTED_SCOPES_ENABLED) === 'true');
  if (
    !code ||
    !verifier ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
    redirectUri !== env.CALLBACK_URL ||
    !receipt ||
    !state ||
    !/^[dw]\.[A-Za-z0-9_-]{43}$/.test(state) ||
    !browserBinding ||
    !/^[A-Za-z0-9_-]{43}$/.test(browserBinding) ||
    !scopes
  ) {
    return { error: 'invalid_body' };
  }
  const bindingHash = await sha256(browserBinding);
  const receiptStatus = await verifyReceipt(
    code,
    state,
    bindingHash,
    receipt,
    env.CALLBACK_RECEIPT_SECRET,
    now,
  );
  if (receiptStatus !== 'valid') return { error: receiptStatus };
  return {
    form: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
    expectedScopes: scopes,
  };
}

function refreshForm(body: Record<string, unknown>, env: Env): PreparedGrant | { error: string } {
  if (body.provider !== 'google') return { error: 'unsupported_provider' };
  const refreshToken = bounded(body.refresh_token, 16 * 1024);
  if (!refreshToken) return { error: 'invalid_body' };
  return {
    form: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  };
}

async function mintReceipt(
  code: string,
  state: string,
  bindingHash: string,
  secret: string,
  now: number,
): Promise<string> {
  const expiresAt = Math.floor(now / 1000) + RECEIPT_TTL_SECONDS;
  const mac = await receiptMac(code, state, bindingHash, expiresAt, secret);
  return `v1.${expiresAt}.${mac}`;
}

async function verifyReceipt(
  code: string,
  state: string,
  bindingHash: string,
  receipt: string,
  secret: string,
  now: number,
): Promise<'valid' | 'invalid_receipt' | 'expired_receipt'> {
  const match = /^v1\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(receipt);
  if (!match) return 'invalid_receipt';
  const expiresAt = Number(match[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt < nowSeconds || expiresAt > nowSeconds + RECEIPT_TTL_SECONDS) {
    return 'expired_receipt';
  }
  const valid = await verifyHmac(
    receiptMessage(code, state, bindingHash, expiresAt),
    match[2]!,
    secret,
  );
  return valid ? 'valid' : 'invalid_receipt';
}

async function receiptMac(
  code: string,
  state: string,
  bindingHash: string,
  expiresAt: number,
  secret: string,
): Promise<string> {
  return hmac(receiptMessage(code, state, bindingHash, expiresAt), secret);
}

function receiptMessage(
  code: string,
  state: string,
  bindingHash: string,
  expiresAt: number,
): string {
  return `callback-receipt\nv1\n${expiresAt}\n${state}\n${bindingHash}\n${code}`;
}

async function hmac(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64UrlEncode(new Uint8Array(signature));
}

async function verifyHmac(message: string, mac: string, secret: string): Promise<boolean> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(mac);
  } catch {
    return false;
  }
  if (bytes.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    new TextEncoder().encode(message),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

function desktopFinishPage(deepLink: string, message: string): Response {
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(18)));
  const safeLink = escapeHtml(deepLink);
  const scriptTarget = JSON.stringify(deepLink).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Return to Centraid</title>
<style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:1.5rem;line-height:1.5;color:#17202a}a{display:inline-block;padding:.75rem 1rem;border-radius:.6rem;background:#17202a;color:white;text-decoration:none}details{margin-top:1.5rem;overflow-wrap:anywhere}</style>
<main><h1>Return to Centraid</h1><p>${escapeHtml(message)}</p><p><a href="${safeLink}">Open Centraid</a></p>
<details><summary>Manual fallback</summary><p>If the button does not work, copy this return link and paste it into Centraid’s connector window:</p><code>${safeLink}</code></details></main>
<script nonce="${nonce}">window.location.replace(${scriptTarget})</script></html>`;
  return withSecurityHeaders(
    new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      },
    }),
  );
}

function finishPage(status: number, title: string, message: string): Response {
  return withSecurityHeaders(
    new Response(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`,
      {
        status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      },
    ),
  );
}

function responseJson(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return withSecurityHeaders(
    Response.json(body, {
      status,
      headers: {
        'cache-control': 'no-store, max-age=0',
        ...headers,
      },
    }),
  );
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store, max-age=0');
  headers.set('cross-origin-resource-policy', 'same-origin');
  headers.set('pragma', 'no-cache');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflight(request: Request): Response {
  const origin = request.headers.get('origin');
  if (!origin || !ALLOWED_BROWSER_ORIGINS.has(origin)) {
    return responseJson(403, { error: 'origin_not_allowed' });
  }
  // Token proxy POSTs are deliberately not browser-CORS enabled: permitting
  // them would allow a compromised shell to read Google tokens.
  return withSecurityHeaders(
    new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET',
        'access-control-max-age': '86400',
        vary: 'Origin',
      },
    }),
  );
}

async function readJsonObject(request: Request, limit: number): Promise<Record<string, unknown>> {
  const text = await readBoundedText(request, limit);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('object only');
  return parsed as Record<string, unknown>;
}

async function readBoundedText(
  message: Pick<Response, 'body' | 'headers'> | Pick<Request, 'body' | 'headers'>,
  limit: number,
): Promise<string> {
  const declared = Number(message.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('body too large');
  if (!message.body) return '';
  const reader = message.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('body too large');
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function metric(env: Env, route: string, outcome: string, status: number): void {
  try {
    env.METRICS.writeDataPoint({
      blobs: [route, outcome],
      doubles: [status, 1],
    });
  } catch {
    // Authentication must not fail because aggregate telemetry is unavailable.
  }
}

function validEnvironment(env: Env, requestUrl: URL): boolean {
  const coordinatesValid =
    requestUrl.origin === PUBLIC_ORIGIN
      ? env.APP_ORIGIN === APP_ORIGIN && env.CALLBACK_URL === CALLBACK_URL
      : requestUrl.origin === DEVELOPMENT_ORIGIN &&
        String(env.CALLBACK_URL) === `${DEVELOPMENT_ORIGIN}/callback` &&
        isLoopbackOrigin(env.APP_ORIGIN);
  return (
    coordinatesValid &&
    /^[A-Za-z0-9._-]{3,512}\.apps\.googleusercontent\.com$/.test(env.GOOGLE_CLIENT_ID) &&
    env.GOOGLE_CLIENT_SECRET.length >= 16 &&
    env.CALLBACK_RECEIPT_SECRET.length >= 32 &&
    ['true', 'false'].includes(String(env.EXCHANGE_ENABLED)) &&
    ['true', 'false'].includes(String(env.RESTRICTED_SCOPES_ENABLED))
  );
}

function isLoopbackUrl(url: URL): boolean {
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  );
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && isLoopbackUrl(url);
  } catch {
    return false;
  }
}

function safeOAuthError(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : 'oauth_upstream_error';
}

function validatedScopes(
  value: unknown,
  restrictedEnabled: boolean,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > STANDARD_GOOGLE_SCOPES.size + RESTRICTED_GOOGLE_SCOPES.size ||
    !value.every((scope): scope is string => typeof scope === 'string')
  ) {
    return undefined;
  }
  const scopes = [...new Set(value)];
  if (scopes.length !== value.length) return undefined;
  const allowed = new Set(STANDARD_GOOGLE_SCOPES);
  if (restrictedEnabled) {
    for (const scope of RESTRICTED_GOOGLE_SCOPES) allowed.add(scope);
  }
  return scopes.every((scope) => allowed.has(scope)) ? scopes : undefined;
}

function sameScopes(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  const actual = [...new Set(value.split(/\s+/).filter(Boolean))].sort();
  const expectedSorted = [...expected].sort();
  return (
    actual.length === expectedSorted.length &&
    actual.every((scope, index) => scope === expectedSorted[index])
  );
}

function bounded(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
