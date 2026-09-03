import { rebootstrapNoticeFrom } from "@centraid/client/replica/native";
import type { ReplicaRebootstrapNotice } from "@centraid/client/replica/native";

export interface ResyncNotice extends ReplicaRebootstrapNotice {
  scopeId?: string;
  at: string;
}

let current: ResyncNotice | undefined;
const listeners = new Set<(notice: ResyncNotice | undefined) => void>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      // Intentionally empty.
    }
  }
}

export function noteResyncVerdict(detail: unknown, scopeId?: string): boolean {
  const notice = rebootstrapNoticeFrom(detail);
  if (!notice || !notice.fullResync) return false;
  current = {
    ...notice,
    ...(scopeId ? { scopeId } : {}),
    at: new Date().toISOString(),
  };
  emit();
  return true;
}

export function readResyncNotice(): ResyncNotice | undefined {
  return current;
}

export function clearResyncNotice(): void {
  if (!current) return;
  current = undefined;
  emit();
}

export function subscribeResyncNotice(
  listener: (notice: ResyncNotice | undefined) => void
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
