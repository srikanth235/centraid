export class OnlineOnlyError extends Error {
  readonly code = 'ONLINE_ONLY';

  constructor(readonly reason: string) {
    super(`Query requires the online vault: ${reason}`);
    this.name = 'OnlineOnlyError';
  }
}
