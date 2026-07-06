/*
 * The vault bridge — `ctx.vault`'s host side (issue: duaility §12).
 *
 * Handlers reach the owner's personal vault through a second RPC channel
 * beside `db`: the worker posts `{type:'vault'}` messages; the host answers
 * them through a bridge injected per app. app-engine stays vault-agnostic —
 * it defines only this contract. The gateway package implements it against
 * `@centraid/vault`, resolving the running app to its enrolled credential
 * before every call, so consent is enforced on the host side of the worker
 * boundary and no signing key ever enters app code.
 *
 * Without an injected bridge every call fails closed with
 * `VAULT_UNAVAILABLE` — apps on gateways that don't mount a vault plane get
 * a clear error, not a hang.
 */

/**
 * Operations `ctx.vault` exposes to handlers. `parked` (the caller's
 * invocations awaiting owner confirmation) and `changes` (the consented
 * journal feed) are agent-plane ops — automation bridges implement them;
 * app bridges may reject them. `resolve` (issue #272) turns (type, id)
 * references into renderable cards under the resolvable-if-linked rule.
 */
export type VaultOp =
  | 'read'
  | 'search'
  | 'invoke'
  | 'query'
  | 'describe'
  | 'parked'
  | 'changes'
  | 'resolve'
  | 'reveal';

/** One proxied call: the op plus its request payload, verbatim from the worker. */
export interface VaultCall {
  op: VaultOp;
  payload: Record<string, unknown>;
}

/**
 * Bridge reply. `ok: false` carries a machine code (`VAULT_UNAVAILABLE`,
 * `VAULT_NOT_ENROLLED`, `VAULT_CONSENT`, …) and a human message — for a
 * consent deny the message includes the receipt id, so even a refusal is
 * auditable from the handler's error.
 */
export interface VaultCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: string;
}

/** Host-injected executor, already bound to the running app's identity. */
export type VaultBridge = (call: VaultCall) => Promise<VaultCallResult>;
