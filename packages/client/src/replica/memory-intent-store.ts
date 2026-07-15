import { ReplicaProtocolError } from './errors.js';
import type { IntentRecordStore, NewStoredIntent } from './intent-store.js';
import type { IntentState, ReplicaIntent } from './types.js';

export class MemoryIntentStore implements IntentRecordStore {
  readonly #records = new Map<string, ReplicaIntent>();
  #nextOrder = 1;

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    const existing = this.#records.get(intent.intentId);
    if (existing) {
      if (existing.payloadHash !== intent.payloadHash) {
        throw new ReplicaProtocolError(
          `Intent id ${intent.intentId} was reused with another payload`,
        );
      }
      return clone(existing);
    }
    const record = { ...clone(intent), createdOrder: this.#nextOrder++ };
    this.#records.set(record.intentId, record);
    return clone(record);
  }

  async get(intentId: string): Promise<ReplicaIntent | undefined> {
    const value = this.#records.get(intentId);
    return value ? clone(value) : undefined;
  }

  async list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    const selected = states ? new Set(states) : undefined;
    return [...this.#records.values()]
      .filter((intent) => !selected || selected.has(intent.state))
      .sort((left, right) => left.createdOrder - right.createdOrder)
      .map(clone);
  }

  async claimNext(): Promise<ReplicaIntent | undefined> {
    const queued = [...this.#records.values()]
      .sort((left, right) => left.createdOrder - right.createdOrder)
      .find((intent) => intent.state === 'queued');
    if (!queued) return undefined;
    return this.transition(queued.intentId, ['queued'], {
      state: 'sending',
      attempts: queued.attempts + 1,
      reason: undefined,
    });
  }

  async transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    const existing = this.#records.get(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(`Intent ${intentId} cannot transition from ${existing.state}`);
    }
    const updated = { ...existing, ...clone(patch), intentId, createdOrder: existing.createdOrder };
    this.#records.set(intentId, updated);
    return clone(updated);
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>,
  ): Promise<ReplicaIntent> {
    const existing = this.#records.get(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(`Intent ${intentId} cannot settle from ${existing.state}`);
    }
    const settled = { ...existing, ...clone(patch), intentId, createdOrder: existing.createdOrder };
    this.#records.delete(intentId);
    return clone(settled);
  }

  async clear(): Promise<void> {
    this.#records.clear();
    this.#nextOrder = 1;
  }

  close(): void {}

  async destroy(): Promise<void> {
    await this.clear();
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
