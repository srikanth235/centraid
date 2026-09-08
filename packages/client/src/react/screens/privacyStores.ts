// Turns holders sideways into `store -> holders[]` (#708 A2). Anything
// unmatched falls into the "Shared identifiers" catch-all.
//
// TWO KINDS OF HOLDER, AND ONLY ONE IS REVOCABLE (#928 A1). An app DECLARES
// its reach at build time — there is no grant to take away, so its row is
// shown and not offered a Revoke. An automation holds a standing ANSWER, one
// `share_authority` row per subject, and that row is what a revoke ends.

import type {
  VaultAgentEntry,
  VaultAnswer,
  VaultAppEntry,
  VaultScope,
} from "../../gateway-client-vault.js";

export type GrantMode = "read" | "write";

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

/** `core` tables outside `DOCS_CORE_TABLES`/`party` are shared plumbing. */
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
      return "shared";
  }
}

function modeForVerbs(verbs: string): GrantMode {
  return verbs.split(",").some((v) => v.trim() !== "read") ? "write" : "read";
}

export interface StoreHolderDTO {
  /** The `share_authority` row a revoke ends; `""` for a declared app. */
  grantId: string;
  holderKind: "app" | "agent";
  holderId: string;
  holderLabel: string;
  mode: GrantMode;
  /** False for an app: a declaration is not a grant and cannot be withdrawn. */
  revocable: boolean;
}

export interface StoreGroup {
  storeId: string;
  label: string;
  holders: StoreHolderDTO[];
}

function holdersFromScopes(
  holderKind: "app" | "agent",
  holderId: string,
  holderLabel: string,
  reach: readonly { grantId: string; scope: VaultScope }[],
  revocable: boolean
): Map<string, StoreHolderDTO> {
  // One row per holder per store, at the strongest mode.
  const byStore = new Map<string, StoreHolderDTO>();
  for (const { grantId, scope } of reach) {
    const storeId = storeIdForScope(scope);
    const mode = modeForVerbs(scope.verbs);
    const existing = byStore.get(storeId);
    if (!existing || (existing.mode === "read" && mode === "write")) {
      byStore.set(storeId, {
        grantId,
        holderKind,
        holderId,
        holderLabel,
        mode,
        revocable,
      });
    }
  }
  return byStore;
}

/** An answer's subject back to the scope it covers — `schema` or `schema.table`. */
function scopeOfAnswer(answer: VaultAnswer): VaultScope {
  const dot = answer.subjectId.indexOf(".");
  const verbs = answer.verb === "act" ? "act" : "read";
  return answer.subjectType === "automation.entity" && dot > 0
    ? {
        schema: answer.subjectId.slice(0, dot),
        table: answer.subjectId.slice(dot + 1),
        verbs,
      }
    : { schema: answer.subjectId, verbs };
}

/** A store with no holders stays in the list; the caller renders that. */
export function groupGrantsByStore(
  apps: readonly VaultAppEntry[],
  agents: readonly VaultAgentEntry[]
): StoreGroup[] {
  const perStore = new Map<string, StoreHolderDTO[]>();
  for (const store of STORES) perStore.set(store.storeId, []);

  for (const app of apps) {
    const holders = holdersFromScopes(
      "app",
      app.appId,
      app.name,
      app.scopes.map((scope) => ({ grantId: "", scope })),
      false
    );
    for (const [storeId, holder] of holders) {
      perStore.get(storeId)?.push(holder);
    }
  }
  for (const agent of agents) {
    const holders = holdersFromScopes(
      "agent",
      agent.agentId,
      agent.name,
      agent.answers
        .filter((answer) => answer.decision === "granted")
        .map((answer) => ({
          grantId: answer.authorityId,
          scope: scopeOfAnswer(answer),
        })),
      true
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

// A revoke DELETES the grant server-side; the snapshot keeps the row visible.

export function revokedHolderKey(storeId: string, grantId: string): string {
  return `${storeId}:${grantId}`;
}

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
