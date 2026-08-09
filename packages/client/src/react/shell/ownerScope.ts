// The shape the scope registry produces (issue #726: ownership replaces
// roles) — kept apart from `useOwnerScopes.ts` because that module reaches
// the gateway client (which binds `window.CentraidApi` at import time); a
// screen that only needs the TYPE should not have to stand up a host bridge
// to get it.

/** One vault the calling owner owns. */
export interface OwnerScope {
  id: string;
  label: string;
  color?: string;
  icon?: string;
  /** Ownership-sourced writability (#726): a vault you own is writable.
   *  Supplied by the gateway, never derived client-side from a role. */
  canWrite: boolean;
}
