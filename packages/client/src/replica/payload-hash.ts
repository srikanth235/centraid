import { webCryptoDigest } from "./digest.js";
import type { ReplicaDigest } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { ReplicaBaseVersion, ReplicaValue } from "./types.js";

/**
 * Hashes the canonical JSON of an intent payload. The gateway pairs
 * `intentId` + `payloadHash` for idempotency, so this value must be identical
 * on every platform: the canonical form below is the contract, and any injected
 * digest must be plain hex SHA-256 over its UTF-8 bytes.
 */
export async function intentPayloadHash(
  input: {
    appId: string;
    action: string;
    input: ReplicaValue;
    baseVersions?: ReplicaBaseVersion[];
    /**
     * THE CHAIN IS PART OF THE PAYLOAD (#996, R23). `dependsOn` decides WHEN
     * an intent runs and which rows its `$intent` placeholders resolve to, so
     * an intent whose predecessors were rewritten in flight is a DIFFERENT
     * intent and must not be answered from the first one's outcome. Omitted
     * when empty, exactly as `baseVersions` is, so an intent that names no
     * chain hashes as it always did — and matches
     * `expectedPayloadHash` in `packages/server/src/routes/replica-intent-shape.ts`
     * byte for byte, which is what the gateway verifies the id against.
     */
    dependsOn?: readonly string[];
  },
  digest: ReplicaDigest = webCryptoDigest
): Promise<string> {
  return digest(
    canonicalJson({
      action: input.action,
      appId: input.appId,
      input: input.input,
      ...(input.baseVersions && input.baseVersions.length > 0
        ? { baseVersions: normalizeBaseVersions(input.baseVersions) }
        : {}),
      ...(input.dependsOn && input.dependsOn.length > 0
        ? { dependsOn: [...input.dependsOn] }
        : {}),
    } as unknown as ReplicaValue)
  );
}

function normalizeBaseVersions(
  values: readonly ReplicaBaseVersion[]
): ReplicaBaseVersion[] {
  return values
    .map((value) => ({
      ...(value.shapeId === undefined ? {} : { shapeId: value.shapeId }),
      entity: value.entity,
      rowId: value.rowId,
      version: value.version,
    }))
    .sort((left, right) =>
      compareBaseVersionKeys(
        baseVersionSortKey(left),
        baseVersionSortKey(right)
      )
    );
}

/**
 * The sort key of one base version: entity, row id, shape id, NUL-joined.
 *
 * Exported so the gateway's `parseBaseVersions` sorts by the same bytes — the
 * two sides hash the SAME array or the hash check refuses every intent.
 */
export function baseVersionSortKey(value: {
  entity: string;
  rowId: string;
  shapeId?: string;
}): string {
  return `${value.entity}\u0000${value.rowId}\u0000${value.shapeId ?? ""}`;
}

/**
 * CODE POINTS, NEVER A LOCALE (#1014, C20).
 *
 * This sorted with `localeCompare`, against this file's own contract that the
 * canonical form is identical on every platform. `localeCompare` is the ICU
 * collation of whatever locale the runtime happens to be in: Hermes on the
 * phone, V8 on the desktop and node on the gateway can order the same two keys
 * differently, and then the seat's `payloadHash` and the gateway's
 * `expectedPayloadHash` disagree — a `replica_intent_hash_mismatch` on a write
 * that is perfectly well formed, or `seat-intent-store` calling the retry a
 * reuse with another payload. `<`/`>` on strings compares UTF-16 code units,
 * which is a property of the STRING and not of the machine.
 */
export function compareBaseVersionKeys(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function canonicalJson(value: ReplicaValue): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new ReplicaProtocolError("Intent payload is not JSON-safe");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
  return `{${entries.join(",")}}`;
}
