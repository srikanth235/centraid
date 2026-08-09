/*
 * A vault's own per-link byte budget for what it holds BORROWED from the
 * other side (#726 P6 gap 2) — the audience's storage preference, keyed
 * exactly like `peer-receive-settings.ts`'s D9 setting: (link_id, vault_id),
 * so setting a budget never touches the link ceremony's own columns and only
 * the vault named by `vaultId` ever reads or writes ITS OWN row.
 *
 * No row means the generous constant default
 * (`DEFAULT_BORROWED_LINK_BYTE_BUDGET`, `lend-blob-pull.ts`) — existing
 * behavior is unchanged until an owner turns the knob. `customBudgetFor`
 * returns `undefined` in that case (not the default) so a caller with its
 * own fallback chain (a sweep-wide override, in tests) can still apply it —
 * a per-link ROW, when one exists, always wins over that wider default.
 */

import type { GatewayDatabase } from "./gateway-db.js";
import { DEFAULT_BORROWED_LINK_BYTE_BUDGET } from "./lend-blob-pull.js";

export function isValidBudgetBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The explicit per-link row, or `undefined` when none was ever set. */
export function customBudgetFor(
  db: GatewayDatabase,
  linkId: string,
  vaultId: string
): number | undefined {
  const row = db.db
    .prepare(
      "SELECT budget_bytes FROM link_borrow_budgets WHERE link_id = ? AND vault_id = ?"
    )
    .get(linkId, vaultId) as { budget_bytes: number } | undefined;
  return row?.budget_bytes;
}

export interface BorrowBudget {
  budgetBytes: number;
  /** `true` when no row exists — `budgetBytes` is the constant default. */
  isDefault: boolean;
}

/** The EFFECTIVE budget for a route/UI to show — resolves the default itself. */
export function budgetFor(
  db: GatewayDatabase,
  linkId: string,
  vaultId: string
): BorrowBudget {
  const custom = customBudgetFor(db, linkId, vaultId);
  return custom === undefined
    ? { budgetBytes: DEFAULT_BORROWED_LINK_BYTE_BUDGET, isDefault: true }
    : { budgetBytes: custom, isDefault: false };
}

/** `vaultId` sets ITS OWN borrow budget for `linkId`. */
export function setBudget(
  db: GatewayDatabase,
  linkId: string,
  vaultId: string,
  budgetBytes: number
): void {
  db.run(
    `INSERT INTO link_borrow_budgets (link_id, vault_id, budget_bytes, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (link_id, vault_id) DO UPDATE SET
       budget_bytes = excluded.budget_bytes, updated_at = excluded.updated_at`,
    linkId,
    vaultId,
    budgetBytes,
    new Date().toISOString()
  );
}
