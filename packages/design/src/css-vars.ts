/**
 * Custom-property reading for hand-written stylesheets (#686).
 *
 * A `var(--x)` with NO fallback that names nothing declared is invalid at
 * computed-value time: the declaration is dropped and the property falls back
 * to inherited/initial. Nothing throws, nothing logs — the rule just silently
 * does not apply, which is how a stale rename survives review. Both
 * `packages/blueprints` and `packages/client` gate for that class (#686).
 *
 * These are the shared, pure halves of both gates — no filesystem, no contract
 * baked in — so the two packages cannot drift into disagreeing about what
 * counts as a declaration or a reference. Each package supplies its own file
 * walker, its own contract (`SHELL_TOKEN_CONTRACT` vs
 * `BLUEPRINT_TOKEN_CONTRACT`), and its own allowlist.
 *
 * NOT re-exported from the package barrel: `packages/client` re-exports that
 * barrel, and oxlint caps it at 100 modules. Reach it at
 * `@centraid/design/css-vars`, the way `./color` and `./oklab` are reached.
 */

/** `--name:` at the head of a declaration — after `{`, after `;`, or at the
 *  start of a line. Built fresh per call: a `/g` regex carries `lastIndex`,
 *  and a shared instance would skip matches on every other call. */
const declarationPattern = (): RegExp =>
  /(?:^|[;{])\s*(?<name>--[A-Za-z0-9_-]+)\s*:/gmu;

/** `var(--name)` or `var(--name, …)`. The trailing group tells the two apart. */
const referencePattern = (): RegExp =>
  /var\(\s*(?<name>--[A-Za-z0-9_-]+)\s*(?<next>[,)])/gu;

/**
 * Drop `/* … *\/` blocks so a documented "was `var(--ink-1)`" note does not
 * read as a live reference, and a commented-out declaration does not count as
 * resolving one.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/** Every custom property the stylesheet DECLARES, in source order, deduped. */
export function declaredCustomProps(css: string): string[] {
  const names = new Set<string>();
  for (const match of css.matchAll(declarationPattern())) {
    const name = match.groups?.name;
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * Every fallback-less `var()` in `css` naming something `resolved` does not
 * contain, deduped and sorted. A reference WITH a fallback is excluded: the
 * author made an explicit choice about the miss, so it is not silent.
 */
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
