export interface ReconcileGateInput {
  hasTransfers: boolean;
  hasFollowups: boolean;
  hasSession: boolean;
}

export function reconcileGate(input: ReconcileGateInput): boolean {
  return input.hasTransfers || (input.hasSession && input.hasFollowups);
}
