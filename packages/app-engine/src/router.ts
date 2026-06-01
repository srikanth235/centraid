/**
 * URL parser for the /centraid prefix route.
 *
 * The plugin registers ONE route (path: "/centraid", match: "prefix") and
 * does its own dispatch. This module turns a raw req.url into a typed
 * Route object and is the only place URL shape lives.
 */

export type Route =
  | { kind: 'registry-list' }
  | { kind: 'registry-deregister'; appId: string }
  | { kind: 'app-schema'; appId: string }
  | {
      kind: 'app-table-rows';
      appId: string;
      tableName: string;
      query: Record<string, string>;
    }
  | { kind: 'app-query'; appId: string }
  | { kind: 'app-logs'; appId: string; query: Record<string, string> }
  | { kind: 'app-index'; appId: string; query: Record<string, string> }
  | { kind: 'app-static'; appId: string; rel: string }
  | { kind: 'app-changes'; appId: string }
  | { kind: 'tool-invoke'; toolName: string }
  | {
      kind: 'app-chat';
      appId: string;
      /** Segments under `/centraid/<appId>/`, starting with `_chat`. */
      segments: string[];
    }
  | { kind: 'app-runner-status' }
  | { kind: 'not-found' };

const PREFIX = '/centraid';
const DRAFT_PREFIX = '/centraid/_draft/';

/**
 * Parse a request URL, peeling off an optional draft-preview prefix
 * (issue #141). A `/centraid/_draft/<sessionId>/<inner…>` URL is rewritten
 * to its inner `/centraid/<inner…>` form (query string preserved) and
 * parsed normally, with the session id returned alongside so the caller
 * can serve the session worktree's code instead of the live version. A
 * URL without the prefix parses exactly as before with no session id.
 */
export function parseWithDraft(
  method: string,
  rawUrl: string,
): { route: Route; draftSessionId?: string } {
  const url = new URL(rawUrl, 'http://localhost');
  if (!url.pathname.startsWith(DRAFT_PREFIX)) {
    return { route: parseRoute(method, rawUrl) };
  }
  const rest = url.pathname.slice(DRAFT_PREFIX.length);
  const slash = rest.indexOf('/');
  const draftSessionId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  const innerPath = slash === -1 ? '' : rest.slice(slash); // leading '/<appId>/…' or ''
  const innerUrl = `${PREFIX}${innerPath}${url.search}`;
  if (!draftSessionId) return { route: { kind: 'not-found' } };
  return { route: parseRoute(method, innerUrl), draftSessionId };
}

export function parseRoute(method: string, rawUrl: string): Route {
  const url = new URL(rawUrl, 'http://localhost');
  let pathname = url.pathname;
  if (!pathname.startsWith(PREFIX)) return { kind: 'not-found' };
  pathname = pathname.slice(PREFIX.length);
  if (pathname === '' || pathname === '/') return { kind: 'not-found' };

  const segments = pathname.split('/').filter(Boolean);
  const m = method.toUpperCase();

  // Registry endpoints — reserved id "_apps". Apps live in the git store;
  // creation/publish goes through the gateway's apps-store surface, not
  // here. This module exposes the read/data/deregister endpoints only.
  if (segments[0] === '_apps') {
    if (segments.length === 1) {
      if (m === 'GET') return { kind: 'registry-list' };
      return { kind: 'not-found' };
    }
    const appId = decodeURIComponent(segments[1] ?? '');
    if (!appId) return { kind: 'not-found' };

    if (segments.length === 2) {
      if (m === 'DELETE') return { kind: 'registry-deregister', appId };
      return { kind: 'not-found' };
    }

    const sub = decodeURIComponent(segments[2] ?? '');

    if (sub === 'schema' && segments.length === 3 && m === 'GET') {
      return { kind: 'app-schema', appId };
    }
    if (sub === 'data' && segments.length === 4 && m === 'GET') {
      const tableName = decodeURIComponent(segments[3] ?? '');
      if (!tableName) return { kind: 'not-found' };
      const query = Object.fromEntries(url.searchParams.entries());
      return { kind: 'app-table-rows', appId, tableName, query };
    }
    if (sub === 'query' && segments.length === 3 && m === 'POST') {
      return { kind: 'app-query', appId };
    }
    if (sub === 'logs' && segments.length === 3 && m === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      return { kind: 'app-logs', appId, query };
    }

    return { kind: 'not-found' };
  }

  // /centraid/_chat/runner-status — gateway-wide preflight for local CLI
  // adapters. Not app-scoped; reserved id `_chat` is checked before the
  // generic `app-*` dispatch below.
  if (segments[0] === '_chat') {
    if (segments[1] === 'runner-status' && segments.length === 2 && m === 'GET') {
      return { kind: 'app-runner-status' };
    }
    return { kind: 'not-found' };
  }

  // /centraid/_tool/<toolName> — the generic three-tool HTTP shim that
  // dispatches `centraid_write`/`_read`/`_describe` for non-MCP callers
  // (the in-iframe `window.centraid.{write,read,describe}` helpers,
  // browser DevTools, scripts). The per-handler `/_run` and `/_data`
  // routes were removed in favour of this shim — see issue #107.
  if (segments[0] === '_tool') {
    if (segments.length !== 2 || m !== 'POST') return { kind: 'not-found' };
    const toolName = decodeURIComponent(segments[1] ?? '');
    if (!toolName) return { kind: 'not-found' };
    return { kind: 'tool-invoke', toolName };
  }

  const appId = decodeURIComponent(segments[0] ?? '');
  if (!appId || appId.startsWith('_')) return { kind: 'not-found' };

  // /centraid/<id> or /centraid/<id>/
  if (segments.length === 1) {
    if (m === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      return { kind: 'app-index', appId, query };
    }
    return { kind: 'not-found' };
  }

  const second = decodeURIComponent(segments[1] ?? '');

  // /centraid/<id>/_changes — Server-Sent Events stream of mutations to the
  // app's data.sqlite. The connection stays open until the client closes.
  if (second === '_changes') {
    if (m !== 'GET' || segments.length !== 2) return { kind: 'not-found' };
    return { kind: 'app-changes', appId };
  }

  // /centraid/<id>/_chat[/...] — per-app chat surface. The sub-route parser
  // in chat-routes.ts owns the method/path matrix; here we just hand it the
  // tail so the dispatch in runtime.ts can stay flat.
  if (second === '_chat') {
    return { kind: 'app-chat', appId, segments: segments.slice(1) };
  }

  // Anything else under /centraid/<id>/... is a static asset request.
  if (m !== 'GET') return { kind: 'not-found' };
  const rel = segments.slice(1).join('/');
  return { kind: 'app-static', appId, rel };
}
