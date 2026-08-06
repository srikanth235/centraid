// THE REFUSAL-GRAMMAR SCANNER (issue #712 E1).
//
// docs/blueprint-seats.md, "Shared engines" 5: *disabled controls visible,
// inert at the handler, and explained inline (never a tooltip)*. The second
// half of that sentence is the one nothing checked — a control can go
// `disabled` with no sentence anywhere near it and every gate in the repo
// stays green, which is exactly how mobile's Face review shipped a "Name →"
// that dies silently when the library has no other named person.
//
// THIS IS A HEURISTIC OVER JSX TEXT, NOT A TYPE-CHECKED PROOF, and it is
// deliberately narrow so it can be trusted:
//
//   * it finds an element whose attribute list carries `disabled` (bare,
//     `disabled={expr}`, or `accessibilityState={{ disabled: expr }}`);
//   * a control disabled ONLY by an in-flight flag (`busy`, `backingUp`,
//     `sending`, …) is EXEMPT — "a write is in flight" is a state the label
//     and the status line already say, and demanding a reason string for
//     every one of them would make the gate noise rather than a rule;
//   * everything else must carry a reason: an `accessibilityHint`, a
//     `title`-free `*Reason`/`unavailableReason` prop, or a rendered
//     `.reason` sibling inside the same enclosing window.
//
// WHAT IT CANNOT SEE: a reason rendered far from the control (more than
// `REASON_WINDOW` lines away), a reason held in a variable whose name says
// nothing, or a disabled state computed inside a child component. Callers
// scope it to a NAMED file list for that reason — see
// `lint-engine-conformance.mjs`.

/** Blank comments only. String bodies are LEFT INTACT: this scanner reads
 *  attribute values (`domain="photos"`) and reason text alike. */
export function blankComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, " "))
    .replace(/\/\/[^\n]*/gu, (m) => " ".repeat(m.length));
}

/**
 * Identifiers that mean "a write is in flight", not "you may never do this".
 * A control gated on ONLY these is exempt (see the header). Kept as a closed
 * list on purpose — a new name has to be argued for here, in one place.
 */
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

/**
 * Identifiers that mean "this control IS the current state", not "you may not
 * do this". A duplicate cluster's kept row is inert because it already says
 * `keep` in its own verdict slot; a segmented control's active segment is
 * inert for the same reason. Pressing either would be a no-op, and "you are
 * already here" is a sentence the control's own label is making. Demanding a
 * separate reason string for these turns the grammar into a tax on selection
 * UI, which is how a rule stops being obeyed.
 */
export const SELECTED_STATE_FLAGS = ["active", "current", "kept", "selected"];

/** Props (or rendered expressions) that count as a stated reason. */
const REASON_SIGNALS =
  /accessibilityHint|unavailableReason|disabledReason|inertReason|refusalReason|\breason\b/u;

/** How far after the `disabled` attribute a sibling reason may be rendered
 *  and still count as "inline". Two panels' worth of JSX; wider than this and
 *  the member is not reading it beside the control. */
const REASON_WINDOW = 14;

/** The lines BEFORE the control that also count — a reason paragraph placed
 *  above its action row (mobile's ConsentGate renders `onDevice.reason`
 *  first, then the actions). */
const REASON_LOOKBACK = 16;

/** Every `disabled`-bearing JSX attribute occurrence in one source text.
 *
 *  `accessibilityState={{ … }}` is read FIRST and then blanked out (offsets
 *  preserved), so the object's own `disabled` key is never also counted as a
 *  bare attribute — and so the shorthand `{{ disabled }}` is read as the
 *  forwarded prop it is rather than as an unconditional refusal. */
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

/** True when the whole disabling expression is in-flight flags and boolean
 *  punctuation — nothing structural in it. */
function onlyInFlight(expr) {
  const identifiers = expr.match(/[A-Za-z_$][\w$]*/gu) ?? [];
  if (identifiers.length === 0) return false;
  const exempt = [...IN_FLIGHT_FLAGS, ...SELECTED_STATE_FLAGS];
  return identifiers.every((name) => exempt.includes(name));
}

/** True when the component is FORWARDING a `disabled` it was handed. The
 *  reason belongs at the call site that computed the refusal, not inside a
 *  generic primitive (`kit/components/Button.tsx`) that only paints it. */
function forwardedProp(expr) {
  return /^(?:props\.)?disabled$/u.test(expr.trim());
}

/**
 * Findings for one file's source. Exported so the test can drive it with
 * fixtures rather than real files.
 */
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
