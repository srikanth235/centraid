// Component existence + action kit + concept schemes (#1018 split).
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  RAW_DIALOG_LEDGER,
  UNSTYLED_BUTTON_LEDGER,
  UNSTYLED_PRESSABLE_LEDGER,
} from "./component-existence-ledger.ts";
import { lineOf, walk } from "./lint-engine-conformance-surface.ts";
import type { SurfaceFile } from "./lint-engine-conformance-surface.ts";

// ─── COMPONENT EXISTENCE ─────────────────────────────────────────────────────
//
// The kit already has the primitive. A raw `<dialog>`, a class-less `<button>`
// or a style-less `<Pressable>` is a second one that will not move when the kit
// does. This is a DEBT LEDGER, not a ban: the counts in
// `scripts/component-existence-ledger.mjs` are what the tree carries today,
// asserted as EQUAL so a new instance and an uncounted cleanup both fail.
// Nothing may be added; wave 5 shrinks it.

const COMPONENT_LEDGER_PATH = "scripts/component-existence-ledger.mjs";

/** Repo-relative label with `/` separators, so ledger keys are platform-stable. */
const posix = (label: string) => label.split(path.sep).join("/");

/**
 * The full text of the opening tag beginning at `start`, read across lines and
 * ignoring `>` inside strings or JSX expression braces (`onClick={() => …}`),
 * so an attribute three lines down still counts as being on the tag.
 */
function openingTagText(code: string, start: number) {
  let braces = 0;
  let quote = null;
  for (let i = start; i < code.length; i++) {
    const char = code[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === ">" && braces === 0) return code.slice(start, i + 1);
  }
  return code.slice(start);
}

/** Per-file count of `<tag` openings whose full opening tag lacks `attribute`. */
export function countBareTags(
  code: string,
  tag: string,
  attribute?: RegExp | string | null
): number {
  let count = 0;
  for (const m of code.matchAll(new RegExp(`<${tag}[\\s>/]`, "gu"))) {
    const at = m.index;
    if (at === undefined) continue;
    const tagText = openingTagText(code, at);
    const present =
      attribute instanceof RegExp
        ? attribute.test(tagText)
        : typeof attribute === "string"
          ? tagText.includes(attribute)
          : false;
    if (attribute && present) continue;
    count++;
  }
  return count;
}

const WEB_SURFACE_PREFIXES = [
  "packages/client/src/",
  "packages/blueprints/apps/",
  "apps/web/src/",
];

/**
 * THE KIT MODALS THEMSELVES. The ledger counts SECOND primitives — a raw
 * `<dialog>` that will not move when the kit does — so the file that IS a kit
 * modal is not debt, and ledgering it would be a line the burn-down could
 * never remove. They are named here rather than budgeted, so an unnamed one
 * still fails (#883 B9).
 *
 * THERE ARE TWO, ONE PER PROGRAM, AND THE WALL BETWEEN THEM IS DELIBERATE.
 * Blueprint app sources are authored against the blueprints ambients and spell
 * their sibling imports with `.ts` extensions; the client program does not
 * enable `allowImportingTsExtensions` — which is why
 * `apps/_shared/grant-transport.ts` takes no relative import at all and why
 * `inline-app-module-stub.d.ts` exists. `KitModal.tsx` imports
 * `./modal-kit.ts`, so the shell cannot compile it. What is genuinely one
 * computation is shared and is NOT duplicated: `apps/_shared/modal-kit.ts` —
 * the platform trap, the platform's own dismissal, and the return of focus —
 * is an import-free leaf that BOTH wrappers call. Each entry is prop plumbing
 * over that one law (#883 B9, wave 5).
 */
const KIT_MODAL_OWNERS = new Set([
  "packages/blueprints/apps/_shared/KitModal.tsx",
  "packages/client/src/react/ui/ShellModal.tsx",
]);

/** One ledger lane: how to count it, where, and what the kit offers instead. */
const COMPONENT_LEDGERS = [
  {
    name: "raw <dialog>",
    ledger: RAW_DIALOG_LEDGER,
    scope: (label: string) =>
      !KIT_MODAL_OWNERS.has(label) &&
      WEB_SURFACE_PREFIXES.some((p) => label.startsWith(p)),
    count: (code: string) => countBareTags(code, "dialog", null),
    fix: "a kit modal owns focus trapping, the backdrop and the return of focus",
  },
  {
    name: "class-less <button>",
    ledger: UNSTYLED_BUTTON_LEDGER,
    scope: (label: string) =>
      WEB_SURFACE_PREFIXES.some((p) => label.startsWith(p)),
    count: (code: string) =>
      countBareTags(code, "button", /\b(?:className|class)\s*=/u),
    fix: "kit Button already carries the target size, the token styling and the focus ring",
  },
  {
    name: "style-less <Pressable>",
    ledger: UNSTYLED_PRESSABLE_LEDGER,
    scope: (label: string) => label.startsWith("apps/mobile/src/"),
    count: (code: string) => countBareTags(code, "Pressable", /\bstyle\s*=/u),
    fix: "apps/mobile/src/kit/components/Tappable.tsx already carries the role, the hit slop that buys the touch floor, the press step and the disabled wiring",
  },
];

export function scanComponentExistence(
  files: SurfaceFile[],
  lanes = COMPONENT_LEDGERS
) {
  const findings: string[] = [];
  for (const { name, ledger, scope, count, fix } of lanes) {
    const seen = new Set();
    for (const { label, code } of files) {
      const key = posix(label);
      if (!scope(key) || /\.(?:test|spec)\./u.test(key)) continue;
      const actual = count(code);
      const ledgerRecord = ledger as Record<string, number>;
      const budget = ledgerRecord[key] ?? 0;
      if (actual === budget) {
        if (actual > 0) seen.add(key);
        continue;
      }
      if (actual > budget) {
        seen.add(key);
        findings.push(
          `${key}: ${actual} ${name} where the ledger allows ${budget} — ${fix}. ` +
            `${COMPONENT_LEDGER_PATH} is tighten-only: raising a count is not the fix.`
        );
        continue;
      }
      seen.add(key);
      findings.push(
        `${key}: ${actual} ${name} but the ledger still claims ${budget} — ` +
          `lower the count in ${COMPONENT_LEDGER_PATH} (or drop the entry) in this PR`
      );
    }
    for (const key of Object.keys(ledger)) {
      if (!seen.has(key))
        findings.push(
          `${key}: listed in the ${name} ledger but carries none (or is gone) — ` +
            `remove the entry from ${COMPONENT_LEDGER_PATH}`
        );
    }
  }
  return findings;
}

// ─── ENGINE K — the action kit ───────────────────────────────────────────────
//
// `apps/_shared/action-kit.ts` owns what a bundled action DOES: hand one typed
// command to `ctx.vault`, pass the outcome back verbatim, and turn a thrown
// refusal into `{status: "denied", reason, code}` at HTTP 200. Before #883 the
// third move was copied byte-for-byte into 128 of the 131 handlers and
// paraphrased in three more — so "every app answers a denial the same way" was
// true only for as long as nobody wrote a 132nd handler by copying the wrong
// one. This lane is what makes it structural.
//
// SCOPED TO THE BUNDLED WEB HANDLERS, deliberately. `automations/**` handlers
// are cloned into the member's own `code/` store and edited there, so a rule
// that bound them would be a rule about the member's code, not ours.
//
// THREE FINDINGS, ONE RULE. A handler must IMPORT the kit; it must not carry a
// `catch` statement of its own (`.catch(…)` on a best-effort promise is not
// one, and Notes' send-to-tasks needs it); and it must not spell the string
// `"denied"`, which is the taxonomy's own word.

const ACTION_KIT_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "action-kit.ts"
);
const ACTION_KIT_VERBS = ["actionInput", "deniedResult", "runVaultAction"];
const ACTION_KIT_SPECIFIER = /_shared\/action-kit(?:\.tsx?)?["']/u;
const BLUEPRINT_ACTION =
  /^packages[\\/]blueprints[\\/]apps[\\/][^\\/]+[\\/]actions[\\/][^\\/]+\.ts$/u;

/** Ratchet — may shrink, never grow. Each entry states WHY it is still here.
 *  Seeded EMPTY: every one of the 131 handlers is on the kit. */
const ACTION_KIT_RATCHET = new Map();

/** Every action handler that has not adopted the kit, before the ratchet. */
export function scanActionKitFiles(files: SurfaceFile[]) {
  const findings: string[] = [];
  for (const { label, code } of files) {
    if (!BLUEPRINT_ACTION.test(label) || /\.(?:test|spec)\./u.test(label))
      continue;
    if (!ACTION_KIT_SPECIFIER.test(code))
      findings.push(
        `${label}:1: does not import ${ACTION_KIT_PATH} — every bundled action ` +
          `dispatches through \`runVaultAction\`, which is the one place a thrown ` +
          `refusal becomes an outcome the surface can narrate`
      );
    // `}` first, so `.catch(() => undefined)` on a best-effort promise passes.
    const statement = code.match(/\}\s*catch\s*\(/u);
    if (statement?.index !== undefined)
      findings.push(
        `${label}:${lineOf(code, statement.index)}: catches its own vault error — ` +
          `the error taxonomy has ONE implementation (${ACTION_KIT_PATH}); a ` +
          `second catch is a second answer to "what does a denial look like"`
      );
    const denial = code.match(/"denied"/u);
    if (denial?.index !== undefined)
      findings.push(
        `${label}:${lineOf(code, denial.index)}: spells the outcome \`"denied"\` ` +
          `itself — call \`deniedResult(reason)\` so every refusal, reached here ` +
          `or thrown by the vault, lands in the same shape`
      );
  }
  return findings;
}

export function checkActionKit(_root: string, files: SurfaceFile[]) {
  const findings: string[] = [];
  const owner = files.find(
    (file: SurfaceFile) => file.label === ACTION_KIT_PATH
  );
  // Anti-vacuity: forbidding a hand-rolled taxonomy means nothing once the one
  // shared implementation stops exporting the verbs the handlers call.
  if (owner) {
    for (const verb of ACTION_KIT_VERBS) {
      if (
        !new RegExp(
          `export\\s+(?:async\\s+)?(?:function|const)\\s+${verb}\\b`,
          "u"
        ).test(owner.code)
      )
        findings.push(
          `${ACTION_KIT_PATH}: no longer exports \`${verb}\` — either the kit ` +
            `lost a verb the handlers depend on, or ACTION_KIT_VERBS is stale`
        );
    }
  } else {
    findings.push(
      `${ACTION_KIT_PATH}: missing — the action-kit gate forbids hand-rolled ` +
        `error taxonomies that would then have no home`
    );
  }
  const adopters = files.filter(
    (file: SurfaceFile) =>
      BLUEPRINT_ACTION.test(file.label) && !/\.test\./u.test(file.label)
  );
  if (adopters.length < 100)
    findings.push(
      `only ${adopters.length} bundled action handlers found — the action-kit ` +
        `lane's path pattern drifted from the layout`
    );
  const offenders = new Set();
  for (const finding of scanActionKitFiles(files)) {
    const ratcheted = [...ACTION_KIT_RATCHET.keys()].find((label) =>
      finding.startsWith(`${label}:`)
    );
    if (ratcheted) offenders.add(ratcheted);
    else findings.push(finding);
  }
  for (const [label, reason] of ACTION_KIT_RATCHET) {
    if (!offenders.has(label))
      findings.push(
        `${label}: ratcheted off the action kit (${reason}) but no longer is — ` +
          `remove it from ACTION_KIT_RATCHET so the gate closes behind you`
      );
  }
  return findings;
}

// ─── ENGINE V — concept-scheme vocabulary ────────────────────────────────────
//
// A blueprint cannot ask the vault for a scheme BY NAME: it reads
// `core.concept_scheme` and matches the URI. So every surface that wanted a
// star, a folder, a list or a free-form label carried its own copy of the
// string — twenty declarations across seven files for seven schemes. A typo in
// one is not a crash, it is a silently empty shelf, which is the worst failure
// a projection has. `apps/_shared/concept-scheme-kit.ts` is the one owner now.
//
// TWO FINDINGS. (a) any of the kit's own URIs spelled outside it — the copies
// that existed. (b) any `https://centraid.dev/schemes/…` literal outside it —
// the copy that has not been written yet, of a scheme the kit does not name.
//
// SCOPED TO THE BLUEPRINT TREE. `apps/mobile/src/apps/**` carries its own
// copies of three of these URIs and cannot import a `.ts` source module from
// this package under every one of its build modes; folding the native seat in
// is its own change, not a string swap.
//
// TEST FILES ARE IN SCOPE — a stale copy in a fixture is how a suite goes on
// passing against a scheme the vault no longer mints. The kit's OWN co-located
// test is the one exemption: its literals are the mirror assertion against the
// vault commands, which is the whole reason the kit may carry them at all.

const BUNDLED_APPS_DIR_NAME = path.join("packages", "blueprints", "apps");

const SCHEME_KIT_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "concept-scheme-kit.ts"
);
const SCHEME_KIT_TEST_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "concept-scheme-kit.test.ts"
);
const BLUEPRINT_APPS_PREFIX = `${path.join("packages", "blueprints", "apps")}${path.sep}`;
/** `export const <NAME>_SCHEME_URI = "…"` in the kit — the vocabulary itself. */
const SCHEME_URI_DECLARATION = /_SCHEME_URI\s*=\s*(?<uri>"[^"]+")/gu;
const SCHEME_URI_SHAPE =
  /["'](?<uri>https:\/\/centraid\.dev\/schemes\/[^"']+)["']/gu;

/**
 * RAW text, not `surfaceFiles`' comment-blanked copy. `blankComments` is
 * string-unaware, so the `//` inside `"https://centraid.dev/schemes/flags"`
 * reads as a line comment and blanks the rest of the line — which would make
 * this lane pass over the exact literal it exists to find. The other engines
 * read attribute values and identifiers, where blanking is what they want.
 */
function blueprintAppFiles(root: string) {
  const dir = path.join(root, BUNDLED_APPS_DIR_NAME);
  return walk(dir).map((absolute) => ({
    label: path.relative(root, absolute),
    code: readFileSync(absolute, "utf8"),
  }));
}

/** Ratchet — may shrink, never grow. Seeded EMPTY: no copy is left. */
const SCHEME_URI_RATCHET = new Map();

/** Every scheme URI spelled outside the kit, before the ratchet. */
export function scanConceptSchemeFiles(
  files: SurfaceFile[],
  kitLabel = SCHEME_KIT_PATH
) {
  const kit = files.find((file: SurfaceFile) => file.label === kitLabel);
  const owned = kit
    ? [...kit.code.matchAll(SCHEME_URI_DECLARATION)].map((m) =>
        (m.groups?.uri ?? "").slice(1, -1)
      )
    : [];
  const findings: string[] = [];
  for (const { label, code } of files) {
    if (
      label === kitLabel ||
      label === SCHEME_KIT_TEST_PATH ||
      !label.startsWith(BLUEPRINT_APPS_PREFIX)
    )
      continue;
    const reported = new Set();
    for (const uri of owned) {
      const index = code.indexOf(`"${uri}"`);
      if (index === -1) continue;
      reported.add(uri);
      findings.push(
        `${label}:${lineOf(code, index)}: spells the concept-scheme URI ` +
          `\`${uri}\` — ${kitLabel} is the one owner; import the constant so a ` +
          `renamed scheme is one edit rather than an empty shelf`
      );
    }
    for (const m of code.matchAll(SCHEME_URI_SHAPE)) {
      if (reported.has(m.groups?.uri)) continue;
      findings.push(
        `${label}:${lineOf(code, m.index)}: names the concept scheme ` +
          `\`${m.groups?.uri}\`, which ${kitLabel} does not carry — add it there and ` +
          `import it, rather than starting a second copy of the vocabulary`
      );
    }
  }
  return findings;
}

export function checkConceptSchemes(root: string) {
  const files = blueprintAppFiles(root);
  const findings: string[] = [];
  const kit = files.find((file) => file.label === SCHEME_KIT_PATH);
  // Anti-vacuity: the whole lane is anchored on the kit still naming schemes.
  const owned = kit ? [...kit.code.matchAll(SCHEME_URI_DECLARATION)] : [];
  if (owned.length < 5)
    findings.push(
      `${SCHEME_KIT_PATH}: names ${owned.length} concept schemes — the ` +
        `vocabulary gate is anchored on this file and has gone vacuous`
    );
  const offenders = new Set();
  for (const finding of scanConceptSchemeFiles(files)) {
    const ratcheted = [...SCHEME_URI_RATCHET.keys()].find((label) =>
      finding.startsWith(`${label}:`)
    );
    if (ratcheted) offenders.add(ratcheted);
    else findings.push(finding);
  }
  for (const [label, reason] of SCHEME_URI_RATCHET) {
    if (!offenders.has(label))
      findings.push(
        `${label}: ratcheted as a scheme-URI copy (${reason}) but no longer is — ` +
          `remove it from SCHEME_URI_RATCHET so the gate closes behind you`
      );
  }
  return findings;
}
