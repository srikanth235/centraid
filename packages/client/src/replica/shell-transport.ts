import {
  authHeaders,
  doFetch,
  GatewayClientError,
  type GatewayAuth,
} from '../gateway-client-core.js';
import { ReplicaProtocolError, ReplicaRebootstrapRequiredError } from './errors.js';
import type { RebootstrapReason } from './replica-rebootstrap-error.js';
import type {
  IntentOutcome,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaIntent,
  ReplicaSnapshot,
} from './types.js';

export type ReplicaFetcher = (
  baseUrl: string,
  pathname: string,
  init: RequestInit,
) => Promise<Response>;

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
  fetcher: ReplicaFetcher = doFetch,
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

export async function fetchReplicaChanges(
  gatewayAuth: GatewayAuth,
  cursor: ReplicaCursor,
  signal: AbortSignal,
  shapeIdsOrFetcher?: readonly string[] | ReplicaFetcher,
  customFetcher: ReplicaFetcher = doFetch,
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
  fetcher: ReplicaFetcher = doFetch,
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
  fetcher: ReplicaFetcher = doFetch,
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
  fetcher: ReplicaFetcher = doFetch,
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
