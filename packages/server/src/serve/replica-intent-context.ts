import { AsyncLocalStorage } from "node:async_hooks";

export interface ReplicaIntentContext {
  intentId: string;
  appId: string;
  deviceId: string;
  /**
   * The owner the intent's device is bound to (issue #599 L4). Carried
   * beside the device id so an offline write replayed from a phone is
   * attributable to the person, not just the hardware.
   */
  ownerId?: string;
}

const storage = new AsyncLocalStorage<ReplicaIntentContext>();

/**
 * Bind an offline intent to the app action currently executing. The app
 * worker still uses the ordinary dispatcher; this host-only context lets its
 * `ctx.vault.invoke` call carry the durable intent id without trusting app
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
