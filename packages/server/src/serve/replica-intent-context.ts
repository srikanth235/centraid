import { AsyncLocalStorage } from "node:async_hooks";

export interface ReplicaIntentContext {
  intentId: string;
  appId: string;
  deviceId: string;
  /** The owner the device is bound to (#599) — a replayed offline write is attributable to the person, not the hardware. */
  ownerId?: string;
}

const storage = new AsyncLocalStorage<ReplicaIntentContext>();

/**
 * Bind an offline intent to the app action currently executing. Host-only:
 * lets `ctx.vault.invoke` carry the durable intent id without trusting app
 * input or broadening the worker protocol.
 */
export function runWithReplicaIntent<T>(
  context: ReplicaIntentContext,
  run: () => T
): T {
  return storage.run(context, run);
}

export function replicaIntentContext(): ReplicaIntentContext | undefined {
  return storage.getStore();
}
