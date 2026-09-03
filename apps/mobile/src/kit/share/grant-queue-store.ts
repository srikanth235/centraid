// Not the replica's SQLite outbox: that dispatches with the APP's credential,
// which `share.grant`'s `confirm: true` parks (#883).
import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  GrantIntentQueue,
  QueuedGrantIntent,
} from "@centraid/blueprints/apps/_shared/grant-transport";

const KEY = "centraid.grant-queue.v1";

function parse(raw: string | null): QueuedGrantIntent[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is QueuedGrantIntent =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as QueuedGrantIntent).intentId === "string" &&
        ((entry as QueuedGrantIntent).op === "create" ||
          (entry as QueuedGrantIntent).op === "revoke")
    );
  } catch {
    return [];
  }
}

/** Let a throwing `AsyncStorage` out: a store that cannot answer is not empty. */
export function nativeGrantIntentQueue(
  storage: Pick<typeof AsyncStorage, "getItem" | "setItem"> = AsyncStorage
): GrantIntentQueue {
  const read = async (): Promise<QueuedGrantIntent[]> =>
    parse(await storage.getItem(KEY));
  const write = (intents: readonly QueuedGrantIntent[]): Promise<void> =>
    storage.setItem(KEY, JSON.stringify(intents));
  return {
    list: read,
    async append(intent) {
      await write([...(await read()), intent]);
    },
    async remove(intentId) {
      const kept = (await read()).filter(
        (intent) => intent.intentId !== intentId
      );
      await write(kept);
    },
  };
}
