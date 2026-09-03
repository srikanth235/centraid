import { AsyncLocalStorage } from "node:async_hooks";

export interface ReplicaIntentContext {
  intentId: string;
  appId: string;
  deviceId: string;
  ownerId?: string;
}

const storage = new AsyncLocalStorage<ReplicaIntentContext>();

export function runWithReplicaIntent<T>(
  context: ReplicaIntentContext,
  run: () => T
): T {
  return storage.run(context, run);
}

export function replicaIntentContext(): ReplicaIntentContext | undefined {
  return storage.getStore();
}
