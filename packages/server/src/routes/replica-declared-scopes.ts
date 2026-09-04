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
  /** `vault.purpose`, carried opaquely so a shape id survives #928's waves. */
  purpose: string;
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
 * The first declared scope that covers this entity for reading — a bare pack
 * scope (`{schema}`) or the entity's own (`{schema, table}`), in declaration
 * order. Same selection the online read makes, so a replica row and an online
 * row carry the same columns.
 */
export function coveringReadScope(
  scopes: readonly ScopeSpec[],
  schema: string,
  table: string
): ScopeSpec | undefined {
  return scopes.find(
    (scope) =>
      READ_VERBS.has(scope.verbs) &&
      scope.schema === schema &&
      (scope.table === undefined || scope.table === table)
  );
}
