import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import { nativeReplicaIdFactory } from "./native-hash";

/** Mint a temporary canonical-looking row id for a local optimistic insert. */
export function optimisticRowId(prefix: string): string {
  return `${prefix}-${nativeReplicaIdFactory()}`;
}

/**
 * Replica query rows carry local `__*` projection metadata. Optimistic values
 * must contain canonical columns only or admission rejects the write.
 */
export function optimisticValues(
  row: ReplicaRow,
  patch: Record<string, ReplicaValue> = {}
): Record<string, ReplicaValue> {
  return {
    ...Object.fromEntries(
      Object.entries(row).filter(([column]) => !column.startsWith("__"))
    ),
    ...patch,
  } as Record<string, ReplicaValue>;
}
