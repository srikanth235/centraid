/*
 * The phone's trace ring and its flush (#927 P1, maintainer ruling OQ1).
 *
 * A phone has no gateway process to append to, and doing disk I/O on a scroll
 * is exactly the kind of work these traces exist to find. So spans accumulate
 * in a BOUNDED IN-MEMORY RING and are written to the owner's diagnostics store
 * at two moments only: when the app goes to the background, and when the
 * developer asks for them. Nothing is written on the hot path, and if the OS
 * kills the app before a background pass the ring is simply lost — a
 * diagnostics buffer, not evidence.
 *
 * Sovereign like every other trace: the file lives inside the app's own replica
 * storage directory, which is removed with the replica, and nothing here opens
 * a socket. Hermes has no `crypto.randomUUID`, so the tracer is constructed
 * with `nativeReplicaIdFactory` (`native-hash.ts`) rather than relying on
 * `@centraid/core`'s web default.
 *
 * OFF BY DEFAULT, same as every other seat: without `EXPO_PUBLIC_CENTRAID_TRACE`
 * the tracer's policy is `TRACE_SAMPLING_OFF` and `begin()` allocates nothing.
 */

import { ClientTracer } from "@centraid/client/replica/native";
import { TRACE_SAMPLING_OFF } from "@centraid/core/protocol";
import type { TraceRecord, TraceSamplingPolicy } from "@centraid/core/protocol";

import { replicaStorageDirectoryUri } from "../../../modules/centraid-storage";
import { nativeReplicaIdFactory } from "./native-hash";

export const NATIVE_TRACE_DIR = "diagnostics";
export const NATIVE_TRACE_FILE = "traces.jsonl";

/** Reads the seat's sampling policy. Absent env means OFF. */
export function nativeTraceSampling(
  env: Record<string, string | undefined> = process.env
): TraceSamplingPolicy {
  if (env.EXPO_PUBLIC_CENTRAID_TRACE !== "1") return TRACE_SAMPLING_OFF;
  const every = Number(env.EXPO_PUBLIC_CENTRAID_TRACE_SAMPLE_EVERY ?? "1");
  if (!Number.isSafeInteger(every) || every < 1) {
    return { enabled: true, sampleEvery: 1 };
  }
  return { enabled: true, sampleEvery: every };
}

let tracer: ClientTracer | undefined;

/** The phone's one tracer; its ring is the buffer a flush drains. */
export function nativeTracer(): ClientTracer {
  tracer ??= new ClientTracer({
    seat: "mobile",
    policy: nativeTraceSampling(),
    idFactory: nativeReplicaIdFactory,
  });
  return tracer;
}

/** Test seam: a fresh tracer with an explicit policy. */
export function resetNativeTracerForTest(policy?: TraceSamplingPolicy): void {
  tracer = new ClientTracer({
    seat: "mobile",
    ...(policy ? { policy } : {}),
    idFactory: nativeReplicaIdFactory,
  });
}

export type TraceWriter = (
  records: readonly TraceRecord[]
) => void | Promise<void>;

/**
 * `expo-file-system` is imported LAZILY, inside the flush and only once there
 * is something to write. A static import would make every module that reaches
 * `background-sync.ts` load Expo's native module graph — which is how a unit
 * test of the background pass ends up needing a React Native runtime. With
 * tracing off (the default) the ring is empty, the flush returns before the
 * import, and nothing Expo-shaped is touched at all.
 */
async function appendToReplicaStorage(
  records: readonly TraceRecord[]
): Promise<void> {
  const root = replicaStorageDirectoryUri();
  if (!root) return;
  const expo = await import("expo-file-system");
  const directory = new expo.Directory(root, NATIVE_TRACE_DIR);
  if (!directory.exists) directory.create({ intermediates: true });
  const file = new expo.File(directory, NATIVE_TRACE_FILE);
  if (!file.exists) file.create();
  const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  file.write(`${file.text()}${lines}`);
}

/**
 * Drain the ring to the diagnostics store. Returns how many records were
 * written; zero when nothing is buffered or the app has no storage directory
 * yet. Swallows its failures — a diagnostics write must never fail a
 * background pass, and the records it dropped were never evidence.
 */
export async function flushNativeTraces(
  write: TraceWriter = appendToReplicaStorage
): Promise<number> {
  const records = nativeTracer().ring.drain();
  if (records.length === 0) return 0;
  try {
    await write(records);
    return records.length;
  } catch {
    return 0;
  }
}
