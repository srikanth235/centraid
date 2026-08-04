// Bounded native text scaling. The text primitive imports this leaf module so
// tests that mock the broader theme API cannot accidentally remove the policy.
export const DYNAMIC_TYPE = {
  allowFontScaling: true,
  maxFontSizeMultiplier: 1.35,
} as const;
