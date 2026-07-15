export type RebootstrapReason =
  | 'not-bootstrapped'
  | 'protocol-mismatch'
  | 'vault-mismatch'
  | 'epoch-mismatch'
  | 'schema-mismatch'
  | 'cursor-gap';

export class ReplicaRebootstrapRequiredError extends Error {
  readonly code = 'REPLICA_REBOOTSTRAP_REQUIRED';

  constructor(readonly reason: RebootstrapReason) {
    super(`Replica must be bootstrapped again (${reason})`);
    this.name = 'ReplicaRebootstrapRequiredError';
  }
}
