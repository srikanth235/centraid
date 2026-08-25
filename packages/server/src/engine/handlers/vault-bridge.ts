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
}

export type VaultBridge = (call: VaultCall) => Promise<VaultCallResult>;
