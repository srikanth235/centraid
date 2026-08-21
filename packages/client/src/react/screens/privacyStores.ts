/*
 * Groups the vault's per-app/per-agent grants BY STORE (issue #708 section A2)
 * — the inversion the brief asks for. Today's consent surfaces (VaultScreen,
 * ApprovalsScreen's "Standing grants") answer "what does this app do?" one app
 * at a time; this module answers "who can see my photos?" by turning the same
 * `(app|agent) -> grants[] -> scopes[]` data sideways into `store -> holders[]`.
 *
 * Pure and framework-free — same shape as `backupMetrics.ts`'s derivation.
 * Inputs are `VaultAppEntry[]` / `VaultAgentEntry[]` (gateway-client-vault.ts),
 * already fetched by the route; this module only reshapes them.
 *
 * STORES is a hand-authored map from (schema[, table]) to the product-facing
 * store a person actually reasons about ("Photos", not "media"). Most schemas
 * are one store; `core` is split at the table level because it is the shared
 * ontology schema every app's scopes route through (`content_item`, `link`,
 * `tag`, …) as well as the literal per-app tables that live in it (`document`
 * for Docs). Anything not matched — future schemas, or `core` tables not yet
 * mapped — falls into the honest "Shared identifiers" catch-all rather than
 * silently vanishing from the ledger.
 */

import type {
  VaultAgentEntry,
  VaultAppEntry,
  VaultScope,
} from "../../gateway-client-vault.js";

export type GrantMode = "read" | "write";

/** One store the ledger is organized by. Order is the render order. */
export interface StoreDefinition {
  storeId: string;
  label: string;
}

export const STORES: readonly StoreDefinition[] = [
  { storeId: "photos", label: "Photos" },
  { storeId: "docs", label: "Documents" },
  { storeId: "notes", label: "Notes" },
  { storeId: "locker", label: "Locker" },
  { storeId: "calendar", label: "Calendar & tasks" },
  { storeId: "money", label: "Money" },
  { storeId: "people", label: "People" },
  { storeId: "shared", label: "Shared identifiers" },
];

const DOCS_CORE_TABLES = new Set([
  "document",
  "create_folder",
  "rename_folder",
  "delete_folder",
  "add_document",
  "rename_document",
  "move_document",
  "trash_document",
  "restore_document",
  "star_document",
  "unstar_document",
  "edit_document",
  "replace_document_content",
  "restore_document_version",
]);

/** One `(schema[, table])` scope → the store id it belongs to. Every `core`
 *  table not in `DOCS_CORE_TABLES` or `party` (`content_item`, `link`,
 *  `tag`, `attachment`, `place`, …) is shared plumbing every app's scopes
 *  route through — it falls through to the "Shared identifiers" catch-all
 *  below rather than being misattributed to whichever app happened to ask
 *  for it first. */
function storeIdForScope(scope: VaultScope): string {
  switch (scope.schema) {
    case "media":
      return "photos";
    case "knowledge":
      return "notes";
    case "locker":
      return "locker";
    case "schedule":
      return "calendar";
    case "tally":
      return "money";
    case "people":
    case "social":
      return "people";
    case "core":
      if (scope.table && DOCS_CORE_TABLES.has(scope.table)) return "docs";
      if (scope.table === "party") return "people";
      return "shared";
    default:
      // consent, blob, enrich, and any future schema: shared plumbing rather
      // than a store a person would recognize by name.
      return "shared";
  }
}

/** `verbs` is a free-form string (e.g. "read", "act", "read,act") — anything
 *  beyond a bare read counts as write for the ledger's coarse mode. */
function modeForVerbs(verbs: string): GrantMode {
  return verbs.split(",").some((v) => v.trim() !== "read") ? "write" : "read";
}

/** One holder's access to one store — the row the ledger renders. */
export interface StoreHolderDTO {
  /** `grantId` (revocable) for an app; `${agentId}` composite for an agent —
   *  agents have no per-scope grantId, they revoke via `agentId`. */
  grantId: string;
  holderKind: "app" | "agent";
  holderId: string;
  holderLabel: string;
  mode: GrantMode;
}

export interface StoreGroup {
  storeId: string;
  label: string;
  holders: StoreHolderDTO[];
}

function holdersFromEntry(
  holderKind: "app" | "agent",
  holderId: string,
  holderLabel: string,
  grants: readonly { grantId: string; scopes: readonly VaultScope[] }[]
): Map<string, StoreHolderDTO> {
  // One holder can hold several grants (and several scopes per grant) that
  // land in the same store — collapse to the single strongest mode rather
  // than one row per grant, so "who can see my photos" reads as one line
  // per app, not one line per consent event.
  const byStore = new Map<string, StoreHolderDTO>();
  for (const grant of grants) {
    for (const scope of grant.scopes) {
      const storeId = storeIdForScope(scope);
      const mode = modeForVerbs(scope.verbs);
      const existing = byStore.get(storeId);
      if (!existing || (existing.mode === "read" && mode === "write")) {
        byStore.set(storeId, {
          grantId: grant.grantId,
          holderKind,
          holderId,
          holderLabel,
          mode,
        });
      }
    }
  }
  return byStore;
}

/**
 * The store-centric ledger: every declared store, in `STORES` order, each
 * carrying the apps/agents that can reach it and in what mode. A store with
 * no holders is still present — its empty `holders` is "reachable by
 * nothing," rendered by the caller, not silently dropped from the list.
 */
export function groupGrantsByStore(
  apps: readonly VaultAppEntry[],
  agents: readonly VaultAgentEntry[]
): StoreGroup[] {
  const perStore = new Map<string, StoreHolderDTO[]>();
  for (const store of STORES) perStore.set(store.storeId, []);

  for (const app of apps) {
    const holders = holdersFromEntry("app", app.appId, app.name, app.grants);
    for (const [storeId, holder] of holders) {
      perStore.get(storeId)?.push(holder);
    }
  }
  for (const agent of agents) {
    const holders = holdersFromEntry(
      "agent",
      agent.agentId,
      agent.name,
      agent.grants
    );
    for (const [storeId, holder] of holders) {
      perStore.get(storeId)?.push(holder);
    }
  }

  return STORES.map((store) => ({
    storeId: store.storeId,
    label: store.label,
    holders: (perStore.get(store.storeId) ?? []).sort((a, b) =>
      a.holderLabel.localeCompare(b.holderLabel)
    ),
  }));
}

// ── The revoked-this-session snapshot (issue #708 A2) ─────────────────────
// A revoke DELETES the grant server-side, so the next fetch simply drops the
// row. Keeping a copy of it as it looked at the moment of revoke is what lets
// the row stay visible, struck through, instead of vanishing — the history of
// who once held a store is the ledger's whole point. Pure, so the rule is
// testable without rendering anything.

/** `${storeId}:${grantId}` — a grant is only unique to a store when both are
 *  present, since the same underlying grant can span several stores' scopes
 *  and each store's row needs its own independent revoked state. */
export function revokedHolderKey(storeId: string, grantId: string): string {
  return `${storeId}:${grantId}`;
}

/**
 * Re-attach any revoked-this-session snapshot whose grant is no longer in the
 * live group (the revoke call deleted it server-side) — pure so it is
 * unit-testable independent of the screen's rendering.
 */
export function mergeRevokedHolders(
  group: StoreGroup,
  revoked: ReadonlyMap<string, StoreHolderDTO>
): StoreGroup {
  const liveIds = new Set(group.holders.map((h) => h.grantId));
  const reattached: StoreHolderDTO[] = [];
  for (const [key, holder] of revoked) {
    if (key !== revokedHolderKey(group.storeId, holder.grantId)) continue;
    if (liveIds.has(holder.grantId)) continue;
    reattached.push(holder);
  }
  return { ...group, holders: [...group.holders, ...reattached] };
}
