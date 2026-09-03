import type { ReplicaRow, ReplicaValue } from "@centraid/client/replica/native";

import { nativeReplicaIdFactory } from "./native-hash";

export function optimisticRowId(prefix: string): string {
  return `${prefix}-${nativeReplicaIdFactory()}`;
}

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
