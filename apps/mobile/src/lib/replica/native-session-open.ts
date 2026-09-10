// OPENING A NATIVE REPLICA SESSION (#1014).
//
// Split out of `native-session.ts` when that file passed the source cap. The
// session is a state machine over a seat and a queue; this is the two-line
// assembly in front of it, and nothing else moved with the text.

import { IntentQueue } from "@centraid/client/replica/native";

import { NativeReplicaSession } from "./native-session";
import type { CreateNativeReplicaSessionOptions } from "./native-session-types";

/** The seat's file holds the queue; both are opened before the session. */
export async function createNativeReplicaSession(
  options: CreateNativeReplicaSessionOptions
): Promise<NativeReplicaSession> {
  // Loaded only when the caller supplies neither, so `node:test` runs (which
  // inject both) never resolve expo-crypto's native module.
  let digest = options.digest;
  let idFactory = options.idFactory;
  if (!digest || !idFactory) {
    const { nativeReplicaDigest, nativeReplicaIdFactory } =
      await import("./native-hash");
    digest ??= nativeReplicaDigest;
    idFactory ??= nativeReplicaIdFactory;
  }
  const queue = new IntentQueue(options.seat.outbox(), { digest, idFactory });
  const session = new NativeReplicaSession({ ...options, queue, idFactory });
  await session.start();
  return session;
}
