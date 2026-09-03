export function withProviderConsent(
  approved: readonly string[],
  provider: string
): string[] {
  return approved.includes(provider) ? [...approved] : [...approved, provider];
}

export function providerConsentWire(
  approved: readonly string[] | undefined
): string | string[] | undefined {
  if (!approved || approved.length === 0) return undefined;
  return approved.length === 1 ? approved[0] : [...approved];
}
