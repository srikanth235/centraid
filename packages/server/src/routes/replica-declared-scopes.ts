/*
 * What an app DECLARES, not what it was granted (#928, AP-apps-declare). A
 * first-party app is not a principal: its reach is fixed at build time by
 * `app.json`'s `vault.scopes`, so a replica shape is composed from the
 * manifest the install path already read, never from a grant row.
 *
 * Keyed by the vault handle rather than by app id alone: two vaults on one
 * gateway may run different versions of the same code-store app, and a shape
 * built from the wrong version would mirror rows that version never declared.
 * A vault the install path has not run for yet holds nothing, and an app with
 * no recorded manifest gets no shape — the fail-closed direction.
 */

import type { DatabaseSync } from "node:sqlite";

import type { ScopeSpec } from "@centraid/vault";

export interface DeclaredManifest {
  scopes: readonly ScopeSpec[];
}

const declared = new WeakMap<DatabaseSync, Map<string, DeclaredManifest>>();

/** The install path is the one reader of an `app.json`, so it is the one writer here. */
export function recordDeclaredManifest(
  vault: DatabaseSync,
  appId: string,
  manifest: DeclaredManifest
): void {
  const perVault = declared.get(vault) ?? new Map<string, DeclaredManifest>();
  declared.set(vault, perVault);
  perVault.set(appId, manifest);
}

export function declaredManifestFor(
  vault: DatabaseSync,
  appId: string
): DeclaredManifest | undefined {
  return declared.get(vault)?.get(appId);
}

const READ_VERBS = new Set<ScopeSpec["verbs"]>(["read", "read+act"]);

/**
 * EVERY DECLARED RESTRICTION BITES (#541, and #928 for the surface path). All
 * the scopes that cover this entity for reading — a bare pack scope
 * (`{schema}`) or the entity's own (`{schema, table}`) — folded the same way
 * the gateway's execution clamp folds them: row filters AND, field masks
 * intersect. Taking the first one instead would let a second, narrower
 * declaration go unenforced on the replica while the online read honoured it,
 * and a replica row and an online row must be the same row with the same
 * columns.
 *
 * `undefined` when nothing covers it — the fail-closed direction.
 */
export function coveringReadScope(
  scopes: readonly ScopeSpec[],
  schema: string,
  table: string
): ScopeSpec | undefined {
  const covering = scopes.filter(
    (scope) =>
      READ_VERBS.has(scope.verbs) &&
      scope.schema === schema &&
      (scope.table === undefined || scope.table === table)
  );
  const first = covering[0];
  if (!first) return undefined;
  const rowFilter: NonNullable<ScopeSpec["rowFilter"]> = [];
  const seen = new Set<string>();
  let fieldMask: string[] | null = null;
  for (const scope of covering) {
    for (const clause of scope.rowFilter ?? []) {
      const key = JSON.stringify(clause);
      if (seen.has(key)) continue;
      seen.add(key);
      rowFilter.push(clause);
    }
    const mask = scope.fieldMask ?? null;
    if (mask === null) continue;
    fieldMask =
      fieldMask === null
        ? [...mask]
        : fieldMask.filter((field) => mask.includes(field));
  }
  return {
    schema,
    ...(first.table === undefined ? {} : { table: first.table }),
    verbs: first.verbs,
    ...(rowFilter.length > 0 ? { rowFilter } : {}),
    ...(fieldMask === null ? {} : { fieldMask }),
  };
}
