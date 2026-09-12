// WHICH SEAT MAY WRITE A SETTLED FOLLOW-UP (#1014, P2).
//
// A phone holds one queue and, at times, several vaults. The follow-up carries
// the vault its bytes were queued for; a session holds exactly one vault
// (#996 wave 3). Before this rule the replay wrote through the MOUNTED session
// whatever the row said, so a photograph queued for the family vault landed in
// the personal one — in the wrong vault, and unrecoverably, because the
// follow-up record was cleared on the way.
//
// Its own leaf because two callers need the identical answer: the replay, and
// the integration suite that proves two vaults on one phone keep their own
// writes. A stamp-less follow-up (queued before the column existed) is written
// by whichever seat is mounted, which is the behaviour it was queued under.

export function followupBelongsToSession(
  targetVaultId: string | undefined,
  sessionVaultId: string | undefined
): boolean {
  if (targetVaultId === undefined || sessionVaultId === undefined) return true;
  return targetVaultId === sessionVaultId;
}
