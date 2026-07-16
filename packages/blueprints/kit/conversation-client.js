// Shared conversation-client wire contract (issue #420) — the ONE place the
// chat routes and the model-picker state shape are defined. Canonical copy:
// packages/blueprints/kit/conversation-client.js. Both the kit's Ask panel
// (relative same-origin fetch) and the React shell (auth-aware doFetch against
// a baseUrl) build their conversation CRUD, blob upload, turn POST, and
// model-picker calls on these route builders + state helpers, so a route or
// wire-shape change lands once. Transport (auth headers, baseUrl) stays
// per-surface — only the URLs and response-shape normalization are shared.

const enc = encodeURIComponent;

// ───────────────────────── route builders ─────────────────────

/** This app's persisted chat sessions (list/create). */
export function conversationsPath(appId) {
  return `/_centraid-conversations/apps/${enc(appId ?? '')}/sessions`;
}

/** One chat session (load/rename/delete/pin/archive). */
export function conversationPath(appId, sessionId) {
  return `${conversationsPath(appId)}/${enc(sessionId)}`;
}

/** FTS search over this app's sessions (issue #420). `q` is the raw query. */
export function conversationSearchPath(appId, query, limit) {
  const params = new URLSearchParams();
  params.set('q', query ?? '');
  if (limit) params.set('limit', String(limit));
  return `${conversationsPath(appId)}/search?${params.toString()}`;
}

/** This app's per-conversation attachment blob CAS (POST uploads). */
export function blobsPath(appId) {
  return `/_centraid-conversations/apps/${enc(appId ?? '')}/blobs`;
}

/** The app copilot turn surface (`POST` an SSE stream). */
export function appTurnPath(appId) {
  return `/centraid/${enc(appId)}/_turn`;
}

/** The app's inline model-picker pref (`GET`/`PUT` `model.<kind>.ask`). */
export function appModelPath(appId) {
  return `/centraid/${enc(appId)}/_turn/model`;
}

/** The shell-level vault-assistant turn surface (same SSE grammar). */
export function assistantTurnPath() {
  return `/centraid/_vault/assistant/_turn`;
}

/** Resolve answer refs (`ref:type/id`) to renderable entity cards. */
export function resolvePath() {
  return `/centraid/_vault/assistant/resolve`;
}

/** The consent surface: parked invocations awaiting the owner's decision. */
export function parkedListPath() {
  return `/centraid/_vault/parked`;
}

/** Post the owner's Approve/Discard on one parked invocation. */
export function parkedDecisionPath(invocationId) {
  return `/centraid/_vault/parked/${enc(invocationId)}`;
}

/** The vault owner status surface (context-chip "connected" signal). */
export function vaultStatusPath() {
  return `/centraid/_vault/status`;
}

/** The enrolled-apps + grants surface (context-chip verb list). */
export function vaultAppsPath() {
  return `/centraid/_vault/apps`;
}

// ───────────────────────── model-picker state ─────────────────────

/**
 * The inline model picker's state, shared by both surfaces. `current` is the
 * subsystem override (null = "use default"); `catalog` is the runner's model
 * list; `defaultModel` is the resolved gateway default's display name.
 * @typedef {{ loaded: boolean, current: string|null, defaultModel: string, catalog: Array<{id: string, label?: string}> }} ModelState
 */

/**
 * Normalize a `GET`/`PUT _turn/model` response body into `ModelState`.
 * @param {unknown} body
 * @returns {import('./conversation-client.js').ModelState}
 */
export function normalizeModelState(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    loaded: true,
    current: b.current || null,
    defaultModel: b.defaultModel || '',
    catalog: Array.isArray(b.catalog) ? b.catalog : [],
  };
}

/**
 * The label the picker button shows for a `ModelState`: the current override's
 * display name, or "Default" when there is no override.
 * @param {import('./conversation-client.js').ModelState} state
 * @returns {string}
 */
export function modelLabel(state) {
  if (!state || !state.loaded) return 'Model';
  if (!state.current) return 'Default';
  const found = state.catalog.find((m) => m.id === state.current);
  return found ? found.label || found.id : state.current;
}

// ───────────────────────── fetch helper ─────────────────────

/**
 * Read a fetch Response into `{ ok, status, body }`, tolerating an empty or
 * non-JSON body (the same shape the kit's `fetchJson` returns). Injectable so
 * both surfaces can share it over their own fetch.
 * @param {Response} res
 * @returns {Promise<{ ok: boolean, status: number, body: unknown }>}
 */
export async function readJsonResponse(res) {
  const text = await res.text().catch(() => '');
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* leave body null on a non-JSON payload */
  }
  return { ok: res.ok, status: res.status, body };
}
