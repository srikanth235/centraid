import { authHeaders, GatewayClientError, href, type GatewayAuth } from '../gateway-auth.js';
import { ReplicaProtocolError, ReplicaRebootstrapRequiredError } from './errors.js';
import type { RebootstrapReason } from './replica-rebootstrap-error.js';
import type {
  IntentOutcome,
  REPLICA_PROTOCOL_VERSION,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaIntent,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
} from './types.js';

/** Matches the gateway's own default; kept explicit so the request is self-describing. */
export const DEFAULT_REPLICA_BOOTSTRAP_WINDOW = 5_000;

/** Request init widened with `cache`, which React Native's `RequestInit` type omits. */
export type ReplicaRequestInit = RequestInit & { cache?: string };

export type ReplicaFetcher = (
  baseUrl: string,
  pathname: string,
  init: ReplicaRequestInit,
) => Promise<Response>;

/**
 * Fallback transport for platforms/tests that don't inject one. The web shell
 * always passes its own `doFetch` wrapper (Iroh/webControl/vault-header aware);
 * this plain `fetch` keeps the module free of the browser gateway core so React
 * Native can reuse it with an injected fetcher.
 */
const defaultReplicaFetcher: ReplicaFetcher = (baseUrl, pathname, init) =>
  fetch(href(baseUrl, pathname), init as RequestInit);

export class ReplicaTransportError extends GatewayClientError {
  constructor(
    code: string,
    message: string,
    readonly status: number,
  ) {
    super(code, message);
    this.name = 'ReplicaTransportError';
  }
}

export interface ReplicaIntentResponse {
  outcome: IntentOutcome | { intentId: string; status: 'in-flight'; reason?: string };
}

const OUTCOME_RECONCILE_BATCH = 500;

export async function fetchReplicaBootstrap(
  gatewayAuth: GatewayAuth,
  fetcher: ReplicaFetcher = defaultReplicaFetcher,
  signal?: AbortSignal,
): Promise<ReplicaSnapshot> {
  const response = await fetcher(gatewayAuth.baseUrl, '/centraid/_vault/replica/bootstrap', {
    method: 'GET',
    headers: { ...authHeaders(gatewayAuth.token), Accept: 'application/json' },
    cache: 'no-store',
    ...(signal ? { signal } : {}),
  });
  const snapshot = await readReplicaJson<ReplicaSnapshot>(response, 'bootstrap replica');
  validateOutcomes(snapshot.outcomes);
  return snapshot;
}

/**
 * One page of a windowed bootstrap. Every page carries its OWN snapshot cursor —
 * pages are not globally consistent — and `complete`/`next` drive the walk.
 */
export interface ReplicaBootstrapPage {
  protocolVersion: typeof REPLICA_PROTOCOL_VERSION;
  vaultId: string;
  schemaEpoch: string;
  cursor: ReplicaCursor;
  rows: ReplicaSnapshotRow[];
  complete: boolean;
  /** Opaque continuation token; absent exactly when `complete` is true. */
  next?: string;
}

/** Page 1 additionally carries the catalog and trust envelope; later pages do not. */
export interface ReplicaBootstrapFirstPage extends ReplicaBootstrapPage {
  shapes: ReplicaShape[];
  shapeIds?: string[];
  trust?: string;
  rememberDevice?: boolean;
}

export interface FetchReplicaBootstrapPageOptions {
  /** Rows per page (server bounds: 1..20000, default 5000). */
  window?: number;
  /** Page-1 `next` token. Omit for page 1. */
  after?: string;
  fetcher?: ReplicaFetcher;
  signal?: AbortSignal;
}

/**
 * Fetch one windowed bootstrap page. Opting in (`window` and/or `after`) is what
 * selects the paging protocol server-side; {@link fetchReplicaBootstrap} keeps
 * the single-shot behavior for callers that pass neither.
 */
export async function fetchReplicaBootstrapPage(
  gatewayAuth: GatewayAuth,
  options: FetchReplicaBootstrapPageOptions = {},
): Promise<ReplicaBootstrapFirstPage | ReplicaBootstrapPage> {
  const fetcher = options.fetcher ?? defaultReplicaFetcher;
  const params = new URLSearchParams();
  if (options.window !== undefined) params.set('window', String(options.window));
  if (options.after !== undefined) params.set('after', options.after);
  // Neither param present would silently fall back to the single-shot envelope.
  if ([...params].length === 0) params.set('window', String(DEFAULT_REPLICA_BOOTSTRAP_WINDOW));
  const response = await fetcher(
    gatewayAuth.baseUrl,
    `/centraid/_vault/replica/bootstrap?${params}`,
    {
      method: 'GET',
      headers: { ...authHeaders(gatewayAuth.token), Accept: 'application/json' },
      cache: 'no-store',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  const page = await readReplicaJson<ReplicaBootstrapPage>(response, 'bootstrap replica');
  validateBootstrapPage(page, options.after === undefined);
  return page;
}

function validateBootstrapPage(page: ReplicaBootstrapPage, first: boolean): void {
  if (typeof page.complete !== 'boolean' || !Array.isArray(page.rows)) {
    throw new ReplicaProtocolError('Replica bootstrap page is malformed');
  }
  if (page.complete === (page.next !== undefined)) {
    throw new ReplicaProtocolError('Replica bootstrap page continuation contradicts completeness');
  }
  if (first && !Array.isArray((page as ReplicaBootstrapFirstPage).shapes)) {
    throw new ReplicaProtocolError('First replica bootstrap page did not carry a catalog');
  }
}

export async function fetchReplicaChanges(
  gatewayAuth: GatewayAuth,
  cursor: ReplicaCursor,
  signal: AbortSignal,
  shapeIdsOrFetcher?: readonly string[] | ReplicaFetcher,
  customFetcher: ReplicaFetcher = defaultReplicaFetcher,
): Promise<ReplicaChangeBatch> {
  const shapeIds =
    shapeIdsOrFetcher === undefined || typeof shapeIdsOrFetcher === 'function'
      ? undefined
      : normalizedShapeIds(shapeIdsOrFetcher);
  const fetcher = typeof shapeIdsOrFetcher === 'function' ? shapeIdsOrFetcher : customFetcher;
  const params = new URLSearchParams({ since: `${cursor.epoch}:${cursor.seq}` });
  // Presence is significant: `shapeIds=` attests a persisted empty catalog.
  if (shapeIds) params.set('shapeIds', shapeIds.join(','));
  const response = await fetcher(gatewayAuth.baseUrl, `/centraid/_vault/changes?${params}`, {
    method: 'GET',
    headers: { ...authHeaders(gatewayAuth.token), Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  const batch = await readReplicaJson<ReplicaChangeBatch>(response, 'pull replica changes');
  validateOutcomes(batch.outcomes);
  return batch;
}

/**
 * Reconcile only the durable outbox entries the client still overlays. The
 * snapshot cursor fences each batch so a newer canonical transition remains
 * in the incremental log instead of clearing its overlay too early.
 */
export async function fetchReplicaIntentOutcomes(
  gatewayAuth: GatewayAuth,
  intentIds: readonly string[],
  through: ReplicaCursor,
  fetcher: ReplicaFetcher = defaultReplicaFetcher,
  signal?: AbortSignal,
): Promise<IntentOutcome[]> {
  const ids = [...new Set(intentIds.filter(Boolean))];
  const outcomes = new Map<string, IntentOutcome>();
  for (let offset = 0; offset < ids.length; offset += OUTCOME_RECONCILE_BATCH) {
    const batch = ids.slice(offset, offset + OUTCOME_RECONCILE_BATCH);
    const response = await fetcher(gatewayAuth.baseUrl, '/centraid/_vault/replica/outcomes', {
      method: 'POST',
      headers: {
        ...authHeaders(gatewayAuth.token, 'application/json'),
        Accept: 'application/json',
      },
      body: JSON.stringify({ intentIds: batch, through }),
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    const body = await readReplicaJson<{ outcomes?: IntentOutcome[] }>(
      response,
      'reconcile replica intents',
    );
    validateOutcomes(body.outcomes);
    for (const outcome of body.outcomes ?? []) {
      if (!batch.includes(outcome.intentId)) {
        throw new ReplicaProtocolError('Replica outcome did not match a requested intent');
      }
      outcomes.set(outcome.intentId, outcome);
    }
  }
  return [...outcomes.values()];
}

function normalizedShapeIds(shapeIds: readonly string[]): string[] {
  return [...new Set(shapeIds.filter((shapeId) => shapeId.length > 0))].sort();
}

export async function postReplicaIntent(
  gatewayAuth: GatewayAuth,
  intent: ReplicaIntent,
  fetcher: ReplicaFetcher = defaultReplicaFetcher,
): Promise<ReplicaIntentResponse> {
  const response = await fetcher(gatewayAuth.baseUrl, '/centraid/_vault/replica/intents', {
    method: 'POST',
    headers: {
      ...authHeaders(gatewayAuth.token, 'application/json'),
      Accept: 'application/json',
    },
    body: JSON.stringify({
      intentId: intent.intentId,
      appId: intent.appId,
      action: intent.action,
      input: intent.input,
      payloadHash: intent.payloadHash,
    }),
  });
  const raw = await readReplicaJson<unknown>(response, 'ship replica intent');
  if (!raw || typeof raw !== 'object' || !('outcome' in raw)) {
    throw new ReplicaProtocolError('Intent response did not contain an outcome');
  }
  const outcome = parseOutcome((raw as { outcome: unknown }).outcome, true);
  if (outcome.intentId !== intent.intentId) {
    throw new ReplicaProtocolError('Intent response did not match the submitted intent');
  }
  return { outcome };
}

export async function postReplicaCheckpoint(
  gatewayAuth: GatewayAuth,
  cursor: ReplicaCursor,
  schemaEpoch: string,
  fetcher: ReplicaFetcher = defaultReplicaFetcher,
): Promise<void> {
  const response = await fetcher(gatewayAuth.baseUrl, '/centraid/_vault/replica/checkpoint', {
    method: 'POST',
    headers: {
      ...authHeaders(gatewayAuth.token, 'application/json'),
      Accept: 'application/json',
    },
    body: JSON.stringify({ cursor, schemaEpoch }),
  });
  await readReplicaJson<unknown>(response, 'save replica checkpoint');
}

async function readReplicaJson<T>(response: Response, operation: string): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new ReplicaProtocolError(`${operation} returned malformed JSON`);
  }
  if (response.status === 409 || response.status === 410) {
    throw new ReplicaRebootstrapRequiredError(rebootstrapReason(body));
  }
  const serverCode =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? String((body as { error: string }).error)
      : undefined;
  if (
    response.status === 401 ||
    (response.status === 403 && serverCode === 'replica_device_not_enrolled')
  ) {
    throw new GatewayClientError('auth_required', `${operation}: device authorization was revoked`);
  }
  if (!response.ok) {
    throw new ReplicaTransportError(
      serverCode ?? (response.status >= 500 ? 'gateway_error' : 'replica_request_rejected'),
      `${operation} failed (HTTP ${response.status})`,
      response.status,
    );
  }
  return body as T;
}

function rebootstrapReason(body: unknown): RebootstrapReason {
  const reason =
    body && typeof body === 'object' ? (body as { reason?: unknown }).reason : undefined;
  if (reason === 'protocol-mismatch' || reason === 'vault-mismatch') return reason;
  if (reason === 'schema-mismatch' || reason === 'schema-changed') return 'schema-mismatch';
  if (reason === 'epoch-mismatch' || reason === 'restore') return 'epoch-mismatch';
  return 'cursor-gap';
}

function validateOutcomes(outcomes: IntentOutcome[] | undefined): void {
  if (outcomes === undefined) return;
  if (!Array.isArray(outcomes)) throw new ReplicaProtocolError('Replica outcomes must be an array');
  for (const outcome of outcomes) parseOutcome(outcome, false);
}

function parseOutcome(
  value: unknown,
  allowInFlight: boolean,
): IntentOutcome | { intentId: string; status: 'in-flight'; reason?: string } {
  if (!value || typeof value !== 'object') {
    throw new ReplicaProtocolError('Replica intent outcome is malformed');
  }
  const candidate = value as Record<string, unknown>;
  const allowed = allowInFlight
    ? new Set(['executed', 'parked', 'denied', 'failed', 'in-flight'])
    : new Set(['executed', 'parked', 'denied', 'failed']);
  if (typeof candidate.intentId !== 'string' || !allowed.has(String(candidate.status))) {
    throw new ReplicaProtocolError('Replica intent outcome has an unknown status');
  }
  if (candidate.reason !== undefined && typeof candidate.reason !== 'string') {
    throw new ReplicaProtocolError('Replica intent outcome reason is malformed');
  }
  return value as IntentOutcome | { intentId: string; status: 'in-flight'; reason?: string };
}
