/*
 * A refusal carrying the host's own code (#1020 wave 4 lane extension).
 *
 * Its own file because `oxlint`'s `max-classes-per-file` is right here rather
 * than merely satisfied: `HostLink` is a connection and this is a value, and a
 * reader looking for "what codes can come back" should not have to read a port's
 * lifetime to find it.
 *
 * `retryable` is the HOST's answer, not this side's guess. v0 classified a retry
 * from the HTTP verb; here the process that performed the request says whether
 * anything happened, which is the question the rule was always about.
 */

export class HostRefusalError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "HostRefusalError";
    this.code = code;
    this.retryable = retryable;
  }
}
