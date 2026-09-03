export function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length));
}

export const IN_FLIGHT_FLAGS = [
  "attaching",
  "authenticating",
  "backingUp",
  "busy",
  "pairing",
  "pending",
  "recede",
  "running",
  "saving",
  "sending",
  "submitting",
  "syncing",
  "working",
];

export const SELECTED_STATE_FLAGS = ["active", "current", "kept", "selected"];

const REASON_SIGNALS =
  /accessibilityHint|unavailableReason|disabledReason|inertReason|refusalReason|\breason\b/u;

const REASON_WINDOW = 14;

const REASON_LOOKBACK = 16;

function disabledSites(code) {
  const sites = [];
  let rest = code;
  const a11y = /accessibilityState\s*=\s*\{\{(?<body>[^}]*)\}\}/gu;
  let match = a11y.exec(code);
  while (match !== null) {
    const body = match.groups.body;
    const keyed = body.match(/\bdisabled\s*:\s*(?<expr>[^,}]*)/u);
    const shorthand = /\bdisabled\s*(?:,|$)/u.test(body);
    if (keyed) sites.push({ index: match.index, expr: keyed.groups.expr });
    else if (shorthand) sites.push({ index: match.index, expr: "disabled" });
    rest =
      rest.slice(0, match.index) +
      match[0].replace(/[^\n]/gu, " ") +
      rest.slice(match.index + match[0].length);
    match = a11y.exec(code);
  }
  const bare = /(?:^|\s)disabled(?:\s*=\s*\{(?<expr>[^}]*)\})?(?=[\s/>])/gmu;
  match = bare.exec(rest);
  while (match !== null) {
    sites.push({ index: match.index, expr: match.groups?.expr ?? "true" });
    bare.lastIndex = match.index + 1;
    match = bare.exec(rest);
  }
  return sites;
}

function onlyInFlight(expr) {
  const identifiers = expr.match(/[A-Za-z_$][\w$]*/gu) ?? [];
  if (identifiers.length === 0) return false;
  const exempt = [...IN_FLIGHT_FLAGS, ...SELECTED_STATE_FLAGS];
  return identifiers.every((name) => exempt.includes(name));
}

function forwardedProp(expr) {
  return /^(?:props\.)?disabled$/u.test(expr.trim());
}

export function scanRefusalGrammar(source, label = "<source>") {
  const code = blankComments(source);
  const lines = code.split("\n");
  const findings = [];
  const seen = new Set();
  for (const site of disabledSites(code)) {
    if (onlyInFlight(site.expr) || forwardedProp(site.expr)) continue;
    const line = code.slice(0, site.index).split("\n").length;
    if (seen.has(line)) continue;
    const window = lines
      .slice(Math.max(0, line - 1 - REASON_LOOKBACK), line + REASON_WINDOW)
      .join("\n");
    if (REASON_SIGNALS.test(window)) continue;
    seen.add(line);
    findings.push(
      `${label}:${line}: a control disabled by \`${site.expr.trim()}\` states ` +
        `no reason — docs/blueprint-seats.md "Shared engines" 5 requires a ` +
        `disabled control to be explained INLINE (accessibilityHint, an ` +
        `\`unavailableReason\`-style prop, or a rendered reason beside it), ` +
        `never a tooltip and never silence`
    );
  }
  return findings;
}
