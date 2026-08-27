/*
 * Host side of `ctx.vault` (duaility §12). App-engine defines the contract;
 * the gateway implements it so no signing key enters app code. Missing
 * bridge → fail closed `VAULT_UNAVAILABLE`.
 */

export type VaultOp =
  | "read"
  | "search"
  | "invoke"
  | "query"
  | "describe"
  | "parked"
  | "changes"
  | "resolve"
  | "reveal"
  | "authenticate"
  | "content";

export interface VaultCall {
  op: VaultOp;
  payload: Record<string, unknown>;
}

export interface VaultCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
  /**
   * When a consent refusal is a REVOCATION, the moment the grant went. An app
   * whose grant was revoked cannot read the consent tables to find this out —
   * that is precisely what it lost — so the host attaches it to the refusal
   * and the app can say "the grant was revoked at 09:02" instead of guessing.
   */
  revokedAt?: string;
}

export type VaultBridge = (call: VaultCall) => Promise<VaultCallResult>;
