import { webCryptoDigest } from "./digest.js";
import type { ReplicaDigest } from "./digest.js";
import { ReplicaProtocolError } from "./errors.js";
import type { ReplicaBaseVersion, ReplicaValue } from "./types.js";

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
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`);
  return `{${entries.join(",")}}`;
}
