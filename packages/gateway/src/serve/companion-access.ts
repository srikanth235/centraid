import type { IncomingMessage } from 'node:http';

/** Constrained Companion devices reach only pinned tools, status, and self-revocation. */
export function companionRequestAllowed(
  req: Pick<IncomingMessage, 'method' | 'url'>,
  grants: readonly string[],
  enrollmentId: string,
): boolean {
  const pathname = new URL(req.url ?? '/', 'http://gateway.local').pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const selfRevokePath = `/centraid/_gateway/devices/${encodeURIComponent(enrollmentId)}`;
  // The pinned app RPC surface: an action or query invocation on a granted
  // module (issue #505). The per-operation allowlist is enforced separately
  // by the runtime's `companionHandlerAllowed` gate.
  const appRpc =
    method === 'POST' && /^\/centraid\/[^_/][^/]*\/(?:actions|queries)\/[^/]+$/.test(pathname);
  return (
    appRpc ||
    pathname === '/centraid/_vault/status' ||
    pathname === '/centraid/_vault/apps' ||
    pathname === '/centraid/_vault/blocking' ||
    (pathname === selfRevokePath && (req.method ?? 'GET').toUpperCase() === 'DELETE') ||
    (pathname === '/centraid/_vault/blobs' &&
      (req.method ?? 'GET').toUpperCase() === 'POST' &&
      grants.includes('docs'))
  );
}
