// Provider-egress consent accumulation for one send attempt (#567).
//
// A single turn can need consent more than once: the owner approves provider A,
// the resend runs, A fails, the ladder fails over to B — and B needs its own
// approval. If the second resend carried ONLY B, the server would find A's
// approval missing again and re-ask for A forever. So every consent retry loop
// keeps the set of providers approved during THIS attempt and sends all of them.
//
// The wire accepts one provider or many (`providerConsent?: string | string[]`);
// a single approval still goes out as a bare string so the common case is
// unchanged on the wire.

/** Append `provider` to the attempt's approved set, preserving order, deduped. */
export function withProviderConsent(
  approved: readonly string[],
  provider: string
): string[] {
  return approved.includes(provider) ? [...approved] : [...approved, provider];
}

/** Shape the approved set for the wire: absent, one, or many. */
export function providerConsentWire(
  approved: readonly string[] | undefined
): string | string[] | undefined {
  if (!approved || approved.length === 0) return undefined;
  return approved.length === 1 ? approved[0] : [...approved];
}
