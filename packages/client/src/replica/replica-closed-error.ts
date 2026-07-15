export class ReplicaClosedError extends Error {
  readonly code = 'REPLICA_CLOSED';

  constructor() {
    super('Replica worker is closed');
    this.name = 'ReplicaClosedError';
  }
}
