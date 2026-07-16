import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readReplicaIntentOutcome,
  recordReplicaIntentOutcome,
  type ReplicaIntentOutcome,
} from '@centraid/vault';
import type { VaultPlane } from '../serve/vault-plane.js';
import { runWithReplicaIntent } from '../serve/replica-intent-context.js';
import { readJson, sendJson } from './route-helpers.js';
import { REPLICA_PROTOCOL_VERSION, type ReplicaShapeAccess } from './replica-shape.js';
import { replicaOutcomeWire } from './replica-projection.js';

export interface ReplicaIntentDispatchInput {
  intentId: string;
  appId: string;
  action: string;
  input: unknown;
}

export type ReplicaIntentDispatchOutcome =
  | { status: 'executed'; output?: unknown }
  | { status: 'parked'; invocationId?: string; reason?: string; output?: unknown }
  | { status: 'denied' | 'failed'; reason: string; output?: unknown }
  | { status: 'retryable'; reason?: string };

export type ReplicaIntentDispatcher = (
  input: ReplicaIntentDispatchInput,
) => Promise<ReplicaIntentDispatchOutcome>;

export interface ReplicaIntentRouteContext {
  plane: VaultPlane;
  access: ReplicaShapeAccess & { deviceId: string };
  dispatch: ReplicaIntentDispatcher;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const NO_TRANSIENT_OUTPUT = Symbol('no transient replica output');

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('intent input is not JSON-safe');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function expectedPayloadHash(appId: string, action: string, input: unknown): string {
  const canonical = canonicalJson({ action, appId, input } as JsonValue);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sameIdentity(
  outcome: ReplicaIntentOutcome,
  input: { deviceId: string; appId: string; action: string; payloadHash: string },
): boolean {
  return (
    outcome.deviceId === input.deviceId &&
    outcome.appId === input.appId &&
    outcome.action === input.action &&
    outcome.payloadHash === input.payloadHash
  );
}

function sendOutcome(
  res: ServerResponse,
  outcome: ReplicaIntentOutcome,
  transientOutput: unknown | typeof NO_TRANSIENT_OUTPUT = NO_TRANSIENT_OUTPUT,
): true {
  const wire = replicaOutcomeWire(outcome);
  if (!wire) {
    return sendJson(res, 202, {
      protocolVersion: REPLICA_PROTOCOL_VERSION,
      accepted: true,
      outcome: { intentId: outcome.intentId, status: 'in-flight' },
    });
  }
  return sendJson(res, wire.status === 'parked' ? 202 : 200, {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    outcome: transientOutput === NO_TRANSIENT_OUTPUT ? wire : { ...wire, output: transientOutput },
  });
}

function concealIdentityConflict(res: ServerResponse, intentId: string): true {
  // UUID collisions are not actionable by the submitting device. Use the
  // ordinary in-flight acknowledgement so another device's durable row is
  // not exposed as an existence oracle, and leave that row untouched.
  return sendJson(res, 202, {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    accepted: true,
    outcome: { intentId, status: 'in-flight' },
  });
}

/** Durable proof that an intent crossed the canonical commit boundary. */
function hasCanonicalCommit(
  plane: VaultPlane,
  intentId: string,
  finalization: 'any' | 'pending',
): boolean {
  return Boolean(
    plane.db.vault
      .prepare(
        `SELECT 1
           FROM replica_invocation_commit
          WHERE intent_id = ?
            ${finalization === 'pending' ? 'AND journal_finalized_at IS NULL' : ''}
          LIMIT 1`,
      )
      .get(intentId),
  );
}

/** Authenticated, durable, device-scoped offline intent admission. */
export async function handleReplicaIntent(
  req: IncomingMessage,
  res: ServerResponse,
  context: ReplicaIntentRouteContext,
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: 'malformed_request',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const intentId = typeof body.intentId === 'string' ? body.intentId : '';
  const appId = typeof body.appId === 'string' ? body.appId : '';
  const action = typeof body.action === 'string' ? body.action : '';
  const payloadHash = typeof body.payloadHash === 'string' ? body.payloadHash : '';
  if (!intentId || !appId || !action || !('input' in body) || !/^[a-f0-9]{64}$/.test(payloadHash)) {
    return sendJson(res, 400, {
      error: 'invalid_replica_intent',
      message: 'intentId, appId, action, input and a SHA-256 payloadHash are required',
    });
  }
  if (context.access.appId && context.access.appId !== appId) {
    return sendJson(res, 400, { error: 'replica_app_scope_mismatch' });
  }
  let computed: string;
  try {
    computed = expectedPayloadHash(appId, action, body.input);
  } catch (error) {
    return sendJson(res, 400, {
      error: 'invalid_replica_intent',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!crypto.timingSafeEqual(Buffer.from(payloadHash), Buffer.from(computed))) {
    return sendJson(res, 400, { error: 'replica_intent_hash_mismatch' });
  }

  const identity = { deviceId: context.access.deviceId, appId, action, payloadHash };
  const existing = readReplicaIntentOutcome(context.plane.db.vault, intentId, identity.deviceId);
  if (existing) {
    if (!sameIdentity(existing, identity)) {
      return concealIdentityConflict(res, intentId);
    }
    // Terminal and parked outcomes are immutable dedupe hits. A `sending`
    // row means the process died between durable admission and outcome;
    // re-enter dispatch with the same intent id, which the dispatcher binds
    // to deterministic vault invocation ids for replay-safe recovery.
    if (replicaOutcomeWire(existing)) return sendOutcome(res, existing);
  }

  const deniedReason =
    context.access.trust !== 'full' ? 'read-only devices cannot submit actions' : undefined;
  if (deniedReason) {
    try {
      const denied = recordReplicaIntentOutcome(context.plane.db.vault, {
        intentId,
        ...identity,
        status: 'denied',
        reason: deniedReason,
      });
      return sendOutcome(res, denied);
    } catch {
      return concealIdentityConflict(res, intentId);
    }
  }

  try {
    recordReplicaIntentOutcome(context.plane.db.vault, {
      intentId,
      ...identity,
      status: 'sending',
    });
  } catch {
    // A wrong-device collision is intentionally indistinguishable from any
    // other immutable-id conflict.
    return concealIdentityConflict(res, intentId);
  }

  // A retained marker means this HTTP attempt is replaying a canonical
  // execution. Its arbitrary handler return was deliberately not persisted,
  // so only a dispatch with no pre-existing marker may surface live output.
  const canonicalCommitExistedBeforeDispatch = hasCanonicalCommit(context.plane, intentId, 'any');
  let dispatched: ReplicaIntentDispatchOutcome;
  try {
    dispatched = await runWithReplicaIntent({ intentId, appId, deviceId: identity.deviceId }, () =>
      context.dispatch({ intentId, appId, action, input: body.input }),
    );
  } catch {
    // Dispatch/transport failure is ambiguous: the canonical command may
    // already have committed and only its journal finalization or response
    // path failed. Keep `sending` so retry re-enters with the same intent id
    // and consumes the canonical commit marker instead of terminalizing a
    // possibly successful action as failed.
    const pending = readReplicaIntentOutcome(context.plane.db.vault, intentId, identity.deviceId);
    if (!pending) {
      return sendJson(res, 500, { error: 'replica_intent_admission_lost' });
    }
    return sendOutcome(res, pending);
  }
  // The worker-facing bridge necessarily reports a post-canonical journal
  // failure as VAULT_ERROR. Blueprints may catch ctx.vault.invoke errors and
  // return a successful `{status: 'denied'}` action envelope, so an unfinished
  // marker makes that terminal result ambiguous. Keep admission retryable
  // until deterministic replay repairs the journal. A fully finalized marker,
  // however, proves only that one invocation committed; it must not overwrite
  // a genuine denial/failure returned by a later invocation in the same action.
  const canonicalFinalizationPending = hasCanonicalCommit(context.plane, intentId, 'pending');
  if (dispatched.status === 'retryable' || canonicalFinalizationPending) {
    const pending = readReplicaIntentOutcome(context.plane.db.vault, intentId, identity.deviceId);
    if (!pending) {
      return sendJson(res, 500, { error: 'replica_intent_admission_lost' });
    }
    return sendOutcome(res, pending);
  }
  let outcome: ReplicaIntentOutcome;
  try {
    outcome = recordReplicaIntentOutcome(context.plane.db.vault, {
      intentId,
      ...identity,
      status: dispatched.status,
      ...(dispatched.status === 'parked' && dispatched.invocationId
        ? { invocationId: dispatched.invocationId }
        : {}),
      ...('reason' in dispatched && dispatched.reason ? { reason: dispatched.reason } : {}),
      // Handler returns are live process data. Never copy an arbitrary value
      // into the durable device outcome; canonical row changes reconcile it.
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'replica_intent_outcome_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return sendOutcome(
    res,
    outcome,
    dispatched.status === 'executed' && !canonicalCommitExistedBeforeDispatch
      ? dispatched.output
      : NO_TRANSIENT_OUTPUT,
  );
}
