// The pure decision at the top of a reconcile (#419 M0.4), split from boot.ts
// so it can be unit-tested without the native module chain boot.ts drags in.

export interface ReconcileGateInput {
  /** Non-terminal upload rows are waiting to transfer. */
  hasTransfers: boolean;
  /** Settled-byte follow-ups are waiting to replay their canonical write. */
  hasFollowups: boolean;
  /** A replica session is available to execute those writes. */
  hasSession: boolean;
}

/**
 * Whether a reconcile is worth resolving the tunnel for. Follow-ups only matter
 * when a session can actually replay them, so with no session and no transfers
 * there is nothing to do but spin the tunnel up for nothing.
 */
export function reconcileGate(input: ReconcileGateInput): boolean {
  return input.hasTransfers || (input.hasSession && input.hasFollowups);
}
