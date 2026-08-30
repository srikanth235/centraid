// EVICTION NEVER TOUCHES A PIN: pins never enter the candidate list at all —
// a structural exclusion, not a filter at the end that gets forgotten (#883).

export interface StoredContentEntry {
  key: string;
  bytes: number;
  /** Epoch ms. */
  lastUsedAt: number;
  pinned: boolean;
}

export interface ContentEvictionPlan {
  evict: string[];
  keptBytes: number;
  pinnedBytes: number;
  overBudgetBy: number;
}

export function planContentEviction(
  entries: readonly StoredContentEntry[],
  budgetBytes: number
): ContentEvictionPlan {
  let pinned = 0;
  let total = 0;
  const candidates: StoredContentEntry[] = [];
  for (const entry of entries) {
    total += entry.bytes;
    if (entry.pinned) pinned += entry.bytes;
    else candidates.push(entry);
  }
  const evict: string[] = [];
  if (total > budgetBytes) {
    const ordered = [...candidates].sort(
      (left, right) =>
        left.lastUsedAt - right.lastUsedAt || left.key.localeCompare(right.key)
    );
    for (const entry of ordered) {
      if (total <= budgetBytes) break;
      total -= entry.bytes;
      evict.push(entry.key);
    }
  }
  return {
    evict,
    keptBytes: total,
    pinnedBytes: pinned,
    overBudgetBy: Math.max(0, total - budgetBytes),
  };
}
