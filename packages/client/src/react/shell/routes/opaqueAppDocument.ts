import type { AppFrameResourceRequest, AppFrameResourceResponse } from './appFrameReplicaBridge.js';

const IROH_VIRTUAL_PREFIX = '/__centraid_iroh__/';
const OPAQUE_CSP_META = 'centraid-opaque-app-csp';

interface TunnelScope {
  origin: string;
  bridgeId: string;
  rootPath: string;
  rootUrl: string;
}

export interface OpaqueAppDocument {
  /** A self-contained document with an opaque principal once sandboxed. */
  documentUrl: string;
  /** Parent-owned fetch capability, locked to this one virtual tunnel scope. */
  fetchResource(request: AppFrameResourceRequest): Promise<AppFrameResourceResponse>;
}

export function isOpaqueAppTunnelUrl(raw: string): boolean {
  return tunnelScope(raw) !== undefined;
}

export async function prepareOpaqueAppDocument(options: {
  appId: string;
  launchUrl: string;
  documentNonce: string;
  fetch?: typeof window.fetch;
}): Promise<OpaqueAppDocument> {
  const scope = tunnelScope(options.launchUrl);
  if (!scope) throw resourceError('App launch URL is not a local Iroh session.');
  const fetcher = options.fetch ?? window.fetch.bind(window);
  const launch = await fetcher(options.launchUrl, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'follow',
  });
  if (!launch.ok) throw resourceError(`App document failed to load (${launch.status}).`);
  const finalUrl = assertStrictlyScopedUrl(launch.url || options.launchUrl, scope);
  assertAppDocumentUrl(finalUrl, scope, options.appId);

  const contentType = launch.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType && !contentType.includes('text/html')) {
    throw resourceError('App session did not return an HTML document.');
  }
  const html = await launch.text();
  const shellNonce = document
    .querySelector<HTMLMetaElement>('meta[name="centraid-csp-nonce"]')
    ?.getAttribute('content');
  if (!shellNonce) throw resourceError('The shell CSP nonce is unavailable.');

  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  if (parsed.querySelector('parsererror')) throw resourceError('App document is malformed.');

  await inlineStylesheets(parsed, finalUrl, scope, options.appId, fetcher);
  await inlineScripts(parsed, finalUrl, scope, options.appId, fetcher);
  hardenDocument(parsed, {
    appId: options.appId,
    appBaseUrl: finalUrl,
    documentNonce: options.documentNonce,
    shellNonce,
  });

  const serialized = `<!doctype html>\n${parsed.documentElement.outerHTML}`;
  return {
    documentUrl: htmlDataUrl(serialized),
    fetchResource: (request) => fetchScopedResource(request, scope, options.appId, fetcher),
  };
}

async function inlineStylesheets(
  parsed: Document,
  appBaseUrl: string,
  scope: TunnelScope,
  appId: string,
  fetcher: typeof window.fetch,
): Promise<void> {
  const links = [...parsed.querySelectorAll<HTMLLinkElement>('link[href]')];
  await Promise.all(
    links.map(async (link) => {
      const rel = new Set(link.rel.toLowerCase().split(/\s+/).filter(Boolean));
      if (!rel.has('stylesheet')) {
        // A data document cannot safely consume preloads, icons, manifests, or
        // alternate documents from the shell origin. The live server already
        // bundles the module graph, so these are presentation hints only.
        link.remove();
        return;
      }
      const url = normalizeScopedUrl(link.getAttribute('href') ?? '', scope, appId, appBaseUrl);
      const response = await fetcher(url, { credentials: 'same-origin' });
      if (!response.ok) throw resourceError(`App stylesheet failed to load (${response.status}).`);
      assertResponseStayedInScope(response, scope, appId);
      const style = parsed.createElement('style');
      if (link.media) style.media = link.media;
      style.textContent = await response.text();
      link.replaceWith(style);
    }),
  );
}

async function inlineScripts(
  parsed: Document,
  appBaseUrl: string,
  scope: TunnelScope,
  appId: string,
  fetcher: typeof window.fetch,
): Promise<void> {
  const scripts = [...parsed.querySelectorAll<HTMLScriptElement>('script[src]')];
  await Promise.all(
    scripts.map(async (script) => {
      const url = normalizeScopedUrl(script.getAttribute('src') ?? '', scope, appId, appBaseUrl);
      const response = await fetcher(url, { credentials: 'same-origin' });
      if (!response.ok) throw resourceError(`App script failed to load (${response.status}).`);
      assertResponseStayedInScope(response, scope, appId);
      const source = (await response.text()).replace(/<\/script/gi, '<\\/script');
      script.removeAttribute('src');
      script.removeAttribute('integrity');
      script.removeAttribute('crossorigin');
      script.textContent = source;
    }),
  );
}

function hardenDocument(
  parsed: Document,
  values: {
    appId: string;
    appBaseUrl: string;
    documentNonce: string;
    shellNonce: string;
  },
): void {
  parsed.querySelectorAll('base').forEach((base) => base.remove());
  parsed
    .querySelectorAll('meta[http-equiv]')
    .forEach((meta) =>
      meta.getAttribute('http-equiv')?.toLowerCase() === 'content-security-policy'
        ? meta.remove()
        : undefined,
    );

  let head = parsed.head;
  if (!head) {
    head = parsed.createElement('head');
    parsed.documentElement.prepend(head);
  }
  const csp = parsed.createElement('meta');
  csp.id = OPAQUE_CSP_META;
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = [
    "default-src 'none'",
    `script-src 'nonce-${values.shellNonce}' blob:`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src data: blob:',
    'object-src blob:',
    'font-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    'worker-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  const bootstrap = parsed.createElement('script');
  // `HTMLScriptElement.nonce` is intentionally hidden in some DOMs and does
  // not reliably reflect into serialization. Set the content attribute: this
  // document is serialized into a data URL before the browser parses it.
  bootstrap.setAttribute('nonce', values.shellNonce);
  bootstrap.textContent = `window.centraid=Object.assign(window.centraid||{},${safeInlineJson({
    appId: values.appId,
    documentNonce: values.documentNonce,
    opaqueBaseUrl: values.appBaseUrl,
  })});`;
  for (const script of parsed.querySelectorAll<HTMLScriptElement>('script')) {
    script.setAttribute('nonce', values.shellNonce);
    if (!script.src && script.textContent) {
      script.textContent = script.textContent.replace(/<\/script/gi, '<\\/script');
    }
  }
  head.prepend(csp, bootstrap);
}

async function fetchScopedResource(
  request: AppFrameResourceRequest,
  scope: TunnelScope,
  appId: string,
  fetcher: typeof window.fetch,
): Promise<AppFrameResourceResponse> {
  const url = normalizeScopedUrl(request.url, scope, appId);
  const method = request.method.toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw resourceError('App resource method is not allowed.');
  }
  const headers = new Headers(request.headers);
  const headerNames = Array.from(headers.keys());
  for (const name of headerNames) {
    const lower = name.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'cookie' ||
      lower === 'host' ||
      lower === 'origin' ||
      lower.startsWith('proxy-') ||
      lower.startsWith('sec-')
    ) {
      headers.delete(name);
    }
  }
  const response = await fetcher(url, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: request.body ?? null }),
    credentials: 'same-origin',
    redirect: 'follow',
  });
  assertResponseStayedInScope(response, scope, appId);
  return {
    url: response.url || url,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers.entries()],
    body: await response.arrayBuffer(),
  };
}

function assertResponseStayedInScope(response: Response, scope: TunnelScope, appId: string): void {
  if (response.url)
    assertAllowedAppResource(assertStrictlyScopedUrl(response.url, scope), scope, appId);
}

function assertAppDocumentUrl(url: string, scope: TunnelScope, appId: string): void {
  const parsed = new URL(url);
  const targetPath = parsed.pathname.slice(scope.rootPath.length);
  if (targetPath !== `/centraid/${encodeURIComponent(appId)}/`) {
    throw resourceError('App session resolved outside the requested app.');
  }
}

function normalizeScopedUrl(
  raw: string,
  scope: TunnelScope,
  appId: string,
  base = scope.rootUrl,
): string {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw resourceError('App resource URL is invalid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw resourceError('App resource protocol is not allowed.');
  }
  if (url.origin !== scope.origin) throw resourceError('App resource escaped the shell origin.');

  if (
    url.pathname.startsWith(IROH_VIRTUAL_PREFIX) &&
    !url.pathname.startsWith(`${scope.rootPath}/`)
  ) {
    throw resourceError('App resource selected another Iroh session.');
  }
  if (!url.pathname.startsWith(`${scope.rootPath}/`)) {
    // Root-relative app code (blob routes, replica capability paths, etc.) was
    // authored for a direct gateway origin. Re-home it under this exact Iroh
    // bridge rather than letting it address the PWA shell.
    url = new URL(`${scope.rootUrl.replace(/\/$/, '')}${url.pathname}${url.search}${url.hash}`);
  }
  if (!url.pathname.startsWith(`${scope.rootPath}/`)) {
    throw resourceError('App resource escaped its Iroh session.');
  }
  assertAllowedAppResource(url.toString(), scope, appId);
  // Cache Storage is shared by every opaque app document under this PWA
  // origin. Pin every parent-fetched capability request to the authenticated
  // app so a guessed content id cannot reuse another app's cached bytes.
  url.searchParams.set('__centraid_app', appId);
  return url.toString();
}

function assertAllowedAppResource(raw: string, scope: TunnelScope, appId: string): void {
  const url = new URL(raw);
  const targetPath = url.pathname.slice(scope.rootPath.length);
  const appRoot = `/centraid/${encodeURIComponent(appId)}/`;
  // App RPC (`actions/`, `queries/`, `_describe`) now lives under the app's
  // own prefix (issue #505), so it is covered here rather than as a shared
  // capability.
  const appOwned = targetPath.startsWith(appRoot);
  // The only shared gateway capability used by app code is the vault blob /
  // replica surface. Its web-session cookie remains app-scoped server-side;
  // the fixed app query above additionally partitions any safe GET response
  // cached by the SW.
  const sharedCapability = targetPath.startsWith('/centraid/_vault/');
  if (!appOwned && !sharedCapability) {
    throw resourceError('App resource escaped the requested app capability.');
  }
}

function assertStrictlyScopedUrl(raw: string, scope: TunnelScope): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw resourceError('App resource URL is invalid.');
  }
  if (url.origin !== scope.origin || !url.pathname.startsWith(`${scope.rootPath}/`)) {
    throw resourceError('App resource escaped its Iroh session.');
  }
  return url.toString();
}

function tunnelScope(raw: string): TunnelScope | undefined {
  try {
    const url = new URL(raw, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(IROH_VIRTUAL_PREFIX)) {
      return undefined;
    }
    const rest = url.pathname.slice(IROH_VIRTUAL_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash < 1) return undefined;
    const bridgeId = rest.slice(0, slash);
    if (!/^[de]-[A-Za-z0-9_-]+$/.test(bridgeId)) return undefined;
    const rootPath = `${IROH_VIRTUAL_PREFIX}${bridgeId}`;
    return {
      origin: url.origin,
      bridgeId,
      rootPath,
      rootUrl: `${url.origin}${rootPath}/`,
    };
  } catch {
    return undefined;
  }
}

function htmlDataUrl(html: string): string {
  const bytes = new TextEncoder().encode(html);
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`;
}

function safeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

function resourceError(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'APP_RESOURCE_DENIED' });
}
