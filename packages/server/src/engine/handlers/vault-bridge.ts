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
  revokedAt?: string;
}

export type VaultBridge = (call: VaultCall) => Promise<VaultCallResult>;
