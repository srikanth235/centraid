import {
  webCryptoDigest,
  webCryptoIdFactory,
  type ReplicaDigest,
  type ReplicaIdFactory,
} from './digest.js';
import type { IntentRecordStore } from './intent-record-store.js';
import { intentPayloadHash } from './payload-hash.js';
import type {
  EnqueueIntentInput,
  IntentOutcome,
  IntentState,
  OptimisticMutation,
  ReplicaIntent,
} from './types.js';

const OVERLAY_STATES = new Set<IntentState>(['queued', 'sending', 'awaiting-change', 'parked']);
const TERMINAL_OUTCOMES = new Set<IntentOutcome['status']>(['executed', 'denied', 'failed']);

export interface IntentQueueOptions {
  idFactory?: ReplicaIdFactory;
  /** RN Hermes has no `crypto.subtle`; native hosts inject an expo-crypto digest. */
  digest?: ReplicaDigest;
}

export class IntentQueue {
  readonly #idFactory: ReplicaIdFactory;
  readonly #digest: ReplicaDigest;

  constructor(
    private readonly store: IntentRecordStore,
    options: IntentQueueOptions = {},
  ) {
    this.#idFactory = options.idFactory ?? webCryptoIdFactory;
    this.#digest = options.digest ?? webCryptoDigest;
  }

  async enqueue(input: EnqueueIntentInput): Promise<ReplicaIntent> {
    const intentId = input.intentId ?? this.#idFactory();
    const payloadHash = await intentPayloadHash(input, this.#digest);
    return this.store.add({
      intentId,
      payloadHash,
      appId: input.appId,
      action: input.action,
      input: input.input,
      state: 'queued',
      attempts: 0,
      optimistic: input.optimistic ?? [],
      dependencies: input.dependencies ?? [],
    });
  }

  claimNext(): Promise<ReplicaIntent | undefined> {
    return this.store.claimNext();
  }

  transportFailed(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ['sending'], { state: 'queued', reason });
  }

  awaitingChange(intentId: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ['sending'], {
      state: 'awaiting-change',
      reason: undefined,
    });
  }

  parked(intentId: string, reason?: string): Promise<ReplicaIntent> {
    return this.store.transition(intentId, ['sending', 'awaiting-change'], {
      state: 'parked',
      reason,
    });
  }

  async applyOutcomes(outcomes: IntentOutcome[]): Promise<ReplicaIntent[]> {
    const updated: ReplicaIntent[] = [];
    for (const outcome of outcomes) {
      const existing = await this.store.get(outcome.intentId);
      if (!existing || !OVERLAY_STATES.has(existing.state)) continue;
      const state = outcome.status;
      const patch = {
        state,
        reason: outcome.reason,
        output: outcome.output,
      };
      updated.push(
        TERMINAL_OUTCOMES.has(outcome.status)
          ? await this.store.settle(outcome.intentId, [...OVERLAY_STATES], patch)
          : await this.store.transition(outcome.intentId, [...OVERLAY_STATES], patch),
      );
    }
    return updated;
  }

  async pending(): Promise<ReplicaIntent[]> {
    return this.store.list([...OVERLAY_STATES]);
  }

  /** A renderer crash can strand claimed work; replay it with the same id and hash. */
  async recoverSending(reason = 'recovered after reload'): Promise<ReplicaIntent[]> {
    const recovered: ReplicaIntent[] = [];
    for (const intent of await this.store.list(['sending'])) {
      recovered.push(
        await this.store.transition(intent.intentId, ['sending'], {
          state: 'queued',
          reason,
        }),
      );
    }
    return recovered;
  }

  async overlayMutations(shapeId?: string, entity?: string): Promise<OptimisticMutation[]> {
    const intents = await this.pending();
    const result: OptimisticMutation[] = [];
    for (const intent of intents) {
      for (const mutation of intent.optimistic) {
        if (shapeId && mutation.shapeId !== shapeId) continue;
        if (entity && mutation.entity !== entity) continue;
        result.push(structuredClone(mutation));
      }
    }
    return result;
  }

  list(): Promise<ReplicaIntent[]> {
    return this.store.list();
  }

  close(): void {
    this.store.close();
  }

  purge(): Promise<void> {
    return this.store.destroy();
  }
}
