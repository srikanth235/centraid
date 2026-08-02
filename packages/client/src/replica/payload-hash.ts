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
  const entries = Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}
