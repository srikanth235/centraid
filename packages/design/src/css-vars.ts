/**
 * Custom-property reading (#686). A fallback-less `var(--x)` that names
 * nothing declared is dropped silently. Import `@centraid/design/css-vars`
 * — not the package barrel.
 */

/** Fresh `/g` regex per call — a shared instance's `lastIndex` skips matches. */
const declarationPattern = (): RegExp =>
  /(?:^|[;{])\s*(?<name>--[A-Za-z0-9_-]+)\s*:/gmu;

const referencePattern = (): RegExp =>
  /var\(\s*(?<name>--[A-Za-z0-9_-]+)\s*(?<next>[,)])/gu;

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

export function declaredCustomProps(css: string): string[] {
  const names = new Set<string>();
  for (const match of css.matchAll(declarationPattern())) {
    const name = match.groups?.name;
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

export function unresolvedVarRefs(
  css: string,
  resolved: ReadonlySet<string>
): string[] {
  const missing = new Set<string>();
  for (const match of css.matchAll(referencePattern())) {
    const name = match.groups?.name;
    if (name === undefined || match.groups?.next === ",") continue;
    if (!resolved.has(name)) missing.add(name);
  }
  return [...missing].sort();
}
