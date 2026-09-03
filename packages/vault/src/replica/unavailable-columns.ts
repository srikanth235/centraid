import type { DatabaseSync } from "node:sqlite";

import { sealedColumnsOf } from "../schema/sealed.js";

const REPLICA_PROTOCOL_CREDENTIAL_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  "access.app": ["signing_key"],
  "access.agent": ["enrollment_key"],
  "access.device": ["public_key"],
};

export function replicaUnavailableColumnsOf(
  entity: string,
  vault?: DatabaseSync
): readonly string[] {
  return [
    ...new Set([
      ...sealedColumnsOf(entity, vault),
      ...(REPLICA_PROTOCOL_CREDENTIAL_COLUMNS[entity] ?? []),
    ]),
  ];
}
