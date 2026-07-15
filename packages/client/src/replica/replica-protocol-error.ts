export class ReplicaProtocolError extends Error {
  readonly code = 'REPLICA_PROTOCOL_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ReplicaProtocolError';
  }
}
