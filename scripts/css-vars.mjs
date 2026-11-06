/** CSS reference validation for authored public-site styles. */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, "");
}

export function declaredCustomProps(css) {
  return [
    ...new Set(
      [...css.matchAll(/(?:^|[;{])\s*(?<name>--[A-Za-z0-9_-]+)\s*:/gmu)].map(
        (match) => match.groups.name
      )
    ),
  ];
}

export function unresolvedVarRefs(css, resolved) {
  const missing = new Set();
  for (const match of css.matchAll(
    /var\(\s*(?<name>--[A-Za-z0-9_-]+)\s*(?<next>[,)])/gu
  )) {
    if (match.groups.next !== "," && !resolved.has(match.groups.name))
      missing.add(match.groups.name);
  }
  return [...missing].sort();
}
