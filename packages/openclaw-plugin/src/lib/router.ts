/**
 * URL parser for the /centraid prefix route.
 *
 * The plugin registers ONE route (path: "/centraid", match: "prefix") and
 * does its own dispatch. This module turns a raw req.url into a typed
 * Route object and is the only place URL shape lives.
 */

export type Route =
  | { kind: 'registry-list' }
  | { kind: 'registry-register' }
  | { kind: 'registry-deregister'; appId: string }
  | { kind: 'app-upload'; appId: string }
  | { kind: 'app-versions-list'; appId: string }
  | { kind: 'app-version-activate'; appId: string }
  | { kind: 'app-version-delete'; appId: string; versionId: string }
  | { kind: 'app-index'; appId: string }
  | { kind: 'app-static'; appId: string; rel: string }
  | { kind: 'app-data'; appId: string; queryName: string; query: Record<string, string> }
  | { kind: 'app-run'; appId: string }
  | { kind: 'app-crons-list'; appId: string }
  | { kind: 'app-cron-runnow'; appId: string; cronId: string }
  | { kind: 'app-ingest'; appId: string; cronId: string }
  | { kind: 'not-found' };

const PREFIX = '/centraid';

export function parseRoute(method: string, rawUrl: string): Route {
  const url = new URL(rawUrl, 'http://localhost');
  let pathname = url.pathname;
  if (!pathname.startsWith(PREFIX)) return { kind: 'not-found' };
  pathname = pathname.slice(PREFIX.length);
  if (pathname === '' || pathname === '/') return { kind: 'not-found' };

  const segments = pathname.split('/').filter(Boolean);
  const m = method.toUpperCase();

  // Registry endpoints — reserved id "_apps".
  if (segments[0] === '_apps') {
    if (segments.length === 1) {
      if (m === 'GET') return { kind: 'registry-list' };
      if (m === 'POST') return { kind: 'registry-register' };
      return { kind: 'not-found' };
    }
    const appId = decodeURIComponent(segments[1] ?? '');
    if (!appId) return { kind: 'not-found' };

    if (segments.length === 2) {
      if (m === 'DELETE') return { kind: 'registry-deregister', appId };
      return { kind: 'not-found' };
    }

    const sub = decodeURIComponent(segments[2] ?? '');

    if (sub === 'upload' && segments.length === 3 && m === 'POST') {
      return { kind: 'app-upload', appId };
    }
    if (sub === 'activate' && segments.length === 3 && m === 'POST') {
      return { kind: 'app-version-activate', appId };
    }
    if (sub === 'versions') {
      if (segments.length === 3 && m === 'GET') {
        return { kind: 'app-versions-list', appId };
      }
      if (segments.length === 4 && m === 'DELETE') {
        const versionId = decodeURIComponent(segments[3] ?? '');
        return { kind: 'app-version-delete', appId, versionId };
      }
    }

    return { kind: 'not-found' };
  }

  const appId = decodeURIComponent(segments[0] ?? '');
  if (!appId || appId.startsWith('_')) return { kind: 'not-found' };

  // /centraid/<id> or /centraid/<id>/
  if (segments.length === 1) {
    if (m === 'GET') return { kind: 'app-index', appId };
    return { kind: 'not-found' };
  }

  const second = decodeURIComponent(segments[1] ?? '');

  // /centraid/<id>/_data/<query>
  if (second === '_data') {
    if (m !== 'GET' || segments.length < 3) return { kind: 'not-found' };
    const queryName = decodeURIComponent(segments[2] ?? '');
    const query = Object.fromEntries(url.searchParams.entries());
    return { kind: 'app-data', appId, queryName, query };
  }

  // /centraid/<id>/_run
  if (second === '_run') {
    if (m !== 'POST') return { kind: 'not-found' };
    return { kind: 'app-run', appId };
  }

  // /centraid/<id>/_crons[/<cron>/run]
  if (second === '_crons') {
    if (segments.length === 2 && m === 'GET') return { kind: 'app-crons-list', appId };
    if (segments.length === 4 && segments[3] === 'run' && m === 'POST') {
      return { kind: 'app-cron-runnow', appId, cronId: decodeURIComponent(segments[2] ?? '') };
    }
    return { kind: 'not-found' };
  }

  // /centraid/<id>/_ingest/<cron>
  if (second === '_ingest') {
    if (m !== 'POST' || segments.length !== 3) return { kind: 'not-found' };
    return { kind: 'app-ingest', appId, cronId: decodeURIComponent(segments[2] ?? '') };
  }

  // Anything else under /centraid/<id>/... is a static asset request.
  if (m !== 'GET') return { kind: 'not-found' };
  const rel = segments.slice(1).join('/');
  return { kind: 'app-static', appId, rel };
}
