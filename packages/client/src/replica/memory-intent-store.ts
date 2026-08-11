import { ReplicaProtocolError } from "./errors.js";
import type {
  IntentRecordStore,
  NewStoredIntent,
} from "./intent-record-store.js";
import {
  buildIntentAttention,
  buildIntentOutcome,
} from "./intent-record-store.js";
import type {
  IntentAttentionRecord,
  IntentOutcome,
  IntentState,
  ReplicaIntent,
} from "./types.js";

export class MemoryIntentStore implements IntentRecordStore {
  readonly #records = new Map<string, ReplicaIntent>();
  readonly #outcomes = new Map<string, IntentOutcome>();
  readonly #attention = new Map<string, IntentAttentionRecord>();
  #nextOrder = 1;

  async add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    const existing = this.#records.get(intent.intentId);
    if (existing) {
      if (existing.payloadHash !== intent.payloadHash) {
        throw new ReplicaProtocolError(
          `Intent id ${intent.intentId} was reused with another payload`
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
      .find((intent) => intent.state === "queued");
    if (!queued) return undefined;
    return this.transition(queued.intentId, ["queued"], {
      state: "sending",
      attempts: queued.attempts + 1,
      reason: undefined,
    });
  }

  async transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const existing = this.#records.get(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(
        `Intent ${intentId} cannot transition from ${existing.state}`
      );
    }
    const updated = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    this.#records.set(intentId, updated);
    return clone(updated);
  }

  async settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const existing = this.#records.get(intentId);
    if (!existing) throw new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      throw new ReplicaProtocolError(
        `Intent ${intentId} cannot settle from ${existing.state}`
      );
    }
    const settled = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    this.#records.delete(intentId);
    const outcome = buildIntentOutcome(settled);
    this.#outcomes.set(intentId, outcome);
    // A settlement that did not execute keeps its row answerable (issue #738):
    // journal it alongside the outcome, in the same step that scrubs the
    // intent, so nothing can observe a lost denial.
    const attention = buildIntentAttention(settled, outcome.settledAt);
    if (attention) this.#attention.set(intentId, clone(attention));
    return clone(settled);
  }

  async listSettled(limit = 500): Promise<IntentOutcome[]> {
    return [...this.#outcomes.values()]
      .sort((left, right) =>
        (right.settledAt ?? "").localeCompare(left.settledAt ?? "")
      )
      .slice(0, limit)
      .map(clone);
  }

  async attention(): Promise<IntentAttentionRecord[]> {
    return [...this.#attention.values()]
      .sort((left, right) => left.settledAt.localeCompare(right.settledAt))
      .map(clone);
  }

  async dismissAttention(intentId: string): Promise<boolean> {
    return this.#attention.delete(intentId);
  }

  async clear(): Promise<void> {
    this.#records.clear();
    this.#outcomes.clear();
    this.#attention.clear();
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
