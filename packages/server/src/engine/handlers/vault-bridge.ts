// Host side of `ctx.vault` (duaility §12). App-engine defines the contract, the gateway implements it so no signing key enters app code.
// Missing bridge → fail closed `VAULT_UNAVAILABLE`.

export type VaultOp =
  | "read"
  | "search"
  | "invoke"
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
   * On a revocation refusal: the moment the grant went. The app cannot read the
   * consent tables to learn this — that is what it lost — so the host attaches it to the refusal.
   */
  revokedAt?: string;
}

export type VaultBridge = (call: VaultCall) => Promise<VaultCallResult>;
