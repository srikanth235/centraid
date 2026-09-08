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
      `${left.entity}\u0000${left.rowId}\u0000${left.shapeId ?? ""}`.localeCompare(
        `${right.entity}\u0000${right.rowId}\u0000${right.shapeId ?? ""}`
      )
    );
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
