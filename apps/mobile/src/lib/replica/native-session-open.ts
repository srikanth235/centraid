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
  // CAPTURED ONCE, NOT RE-ASKED (#1014, C11). `outbox()` mints a new store
  // over a new driver after a re-bootstrap, and the mirror the session has to
  // invalidate is the one the QUEUE was built over — this instance.
  const outboxStore = options.seat.outbox();
  const queue = new IntentQueue(outboxStore, { digest, idFactory });
  const session = new NativeReplicaSession({
    ...options,
    queue,
    idFactory,
    outboxStore,
  });
  await session.start();
  return session;
}
