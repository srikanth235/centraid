/**
 * Which people the merge picker offers.
 *
 * Kept out of the screen so it is testable without the native tree, and because
 * the narrowing carries a real promise: the directory reaches ~5,000 profiles,
 * and the picker's job is to make sure that many rows never arrive at once.
 */
export interface MergeCandidate {
  party_id: string;
  name: unknown;
}

export function mergeCandidates<T extends MergeCandidate>(
  people: readonly T[],
  excludePartyId: string | undefined,
  query: string
): T[] {
  const needle = query.trim().toLowerCase();
  return people.filter(
    (person) =>
      person.party_id !== excludePartyId &&
      (needle.length === 0 ||
        String(person.name).toLowerCase().includes(needle))
  );
}
