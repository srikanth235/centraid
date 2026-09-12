/**
 * THE SEAT'S OWN DOOR SAID THIS DEVICE IS NOT ENROLLED (#1014, X8).
 *
 * Purge-on-revocation used to fire only from the intent DRAIN, which means a
 * seat that only reads — a member who has queued nothing since the revocation,
 * which is most of them — kept its whole copy of the vault indefinitely. The
 * gateway had already refused it; nothing on the device acted on the refusal.
 *
 * So the log door's 401, and its 403 for `replica_device_not_enrolled`, raise
 * this instead of a bare `Error`, and the hosts treat it exactly as the drain's
 * `auth_required`: one revocation policy on both hosts (R-1014-12).
 *
 * It is NOT a `SeatDriftError`: drift is answered by re-bootstrapping, and
 * downloading the vault again from a gateway that has revoked you is the loop
 * this replaces.
 */
export class SeatAuthorizationRevokedError extends Error {
  override readonly name = "SeatAuthorizationRevokedError";
  readonly code = "auth_required";
  readonly recovery = "purge";
  constructor(readonly vaultId: string) {
    super(`seat log door refused ${vaultId}: device authorization was revoked`);
  }
}

export function isSeatAuthorizationRevoked(error: unknown): boolean {
  return error instanceof SeatAuthorizationRevokedError;
}
