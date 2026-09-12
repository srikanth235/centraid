// Engine H / S / E — pending overlay, search status, selection (#1018 split).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { lineOf } from "./lint-engine-conformance-surface.ts";
import type { SurfaceFile } from "./lint-engine-conformance-surface.ts";

// ─── ENGINE H — pending-write overlay ──────────────────────────────────────
//
// The durable outbox is part of every local read. Blueprint apps declare row
// projection only; browser/native shells attach identity and status. These
// spellings name the app-owned stores #738 removed and therefore cannot
// return under a new component without failing the cross-tree gate.

const PENDING_OVERLAY_APPS = [
  "agenda",
  "docs",
  "locker",
  "notes",
  "people",
  "photos",
  "tally",
  "tasks",
];
const HANDROLLED_PENDING_STORES = [
  "pendingExpenses",
  "pendingAdds",
  "pendingIds",
  "pendingByIntent",
  "pendingNoteIds",
  "pendingNotebookIds",
];

// This second vocabulary tripwire catches ordinary renamed variants of the
// stores above wherever they are declared (binding, hook tuple, property, or
// class field). The dataflow check below covers arbitrary collection names.
const SOURCE_IDENTIFIER = /\b[A-Za-z_$][\w$]*\b/gu;
const PENDING_COLLECTION_STATE = /(?:pending|queued|optimistic|overlay)/iu;
const PENDING_COLLECTION_VALUE =
  /(?:rows|adds|ids|writes|mutations|expenses|records|items|byIntent|list|map|set)$/iu;
const SHARED_PENDING_COLLECTION_VERBS = new Set(["enrichPendingRows"]);

// The architectural boundary is independent of local naming. App surfaces may
// declare projections through apps/_shared/pending-overlay, but they may not
// construct, read, or fold the outbox engine directly. A store called
// `stagedEntities` is still caught when it reaches past that declaration door.
const PENDING_ENGINE_REACH_PAST = [
  "IntentQueue",
  "applyOptimisticMutations",
  "overlayMutations",
  "evaluateReplicaRead",
  "intent-record-store",
  "intent-store",
  "memory-intent-store",
  "replica/coordinator",
  "replica/intents",
  "replica/store-core",
];

function isPendingCollectionIdentifier(identifier: string) {
  const collection = identifier.replace(/^set(?=[A-Z])/u, "");
  return (
    PENDING_COLLECTION_STATE.test(collection) &&
    PENDING_COLLECTION_VALUE.test(collection)
  );
}

function maskStaticImports(code: string) {
  return code.replace(
    /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["'][^"']+["'];?/gu,
    (statement: string) => statement.replace(/[^\n]/gu, " ")
  );
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Reject an app-owned collection populated from a replica write result even
 * when every local identifier avoids pending/queued/overlay vocabulary. This
 * is the semantic hand-overlay shape #738 removes: durable query results are
 * the row store, so write acknowledgements must never be folded into hook
 * state for presentation.
 */
function writeBackedCollectionFindings(label: string, code: string) {
  const findings: string[] = [];
  const assignedWriteResults = [
    ...code.matchAll(
      /\b(?:const|let|var)\s+(?<result>[A-Za-z_$][\w$]*)\s*=\s*await\s+(?:window\.)?centraid\.write\s*\(/gu
    ),
  ].flatMap((match) => (match.groups?.result ? [match.groups?.result] : []));
  const collections = code.matchAll(
    /\bconst\s*\[\s*(?<name>[A-Za-z_$][\w$]*)\s*,\s*(?<setter>[A-Za-z_$][\w$]*)\s*\]\s*=\s*(?:React\.)?useState(?:<[^;\n>]*>)?\s*\(\s*\[\s*\]\s*\)/gu
  );
  for (const collection of collections) {
    const name = collection.groups?.name;
    const setter = collection.groups?.setter;
    if (!name || !setter) continue;
    const setterCall = new RegExp(
      `\\b${escapeRegularExpression(setter)}\\s*\\(([\\s\\S]{0,1200}?)\\)`,
      "gu"
    );
    const writesCollection = [...code.matchAll(setterCall)].some((call) => {
      const body = call[1] ?? "";
      return (
        /(?:window\.)?centraid\.write\s*\(/u.test(body) ||
        assignedWriteResults.some((result) =>
          new RegExp(`\\b${escapeRegularExpression(result)}\\b`, "u").test(body)
        )
      );
    });
    if (!writesCollection) continue;
    findings.push(
      `${label}:${lineOf(code, collection.index)}: stores replica write results ` +
        `in local collection \`${name}\` — replica ⊕ outbox is the one row store`
    );
  }
  return findings;
}

export function scanPendingOverlayFiles(files: SurfaceFile[]) {
  const findings: string[] = [];
  for (const { label, code } of files) {
    const appSource =
      label.startsWith(
        `${path.join("packages", "blueprints", "apps")}${path.sep}`
      ) ||
      label.startsWith(
        `${path.join("apps", "mobile", "src", "apps")}${path.sep}`
      );
    if (
      !appSource ||
      /(?:\.test\.|pending-projection\.ts$|_shared\/pending-(?:overlay|projections)\.ts$)/u.test(
        label
      )
    )
      continue;
    for (const spelling of HANDROLLED_PENDING_STORES) {
      const index = code.indexOf(spelling);
      if (index !== -1)
        findings.push(
          `${label}:${lineOf(code, index)}: owns \`${spelling}\` — pending rows ` +
            `come from replica ⊕ outbox; declare the action in pending-projection.ts`
        );
    }
    const reportedCollections = new Set();
    // Importing the shared engine's own `enrichPendingRows` verb is adoption,
    // not ownership of a local collection. Mask only static import clauses;
    // declarations and uses in the app body remain visible to the tripwire.
    const declarationCode = maskStaticImports(code);
    findings.push(...writeBackedCollectionFindings(label, declarationCode));
    for (const match of declarationCode.matchAll(SOURCE_IDENTIFIER)) {
      const identifier = match[0];
      const collection = identifier.replace(/^set(?=[A-Z])/u, "");
      const collectionKey = collection.toLowerCase();
      if (
        !isPendingCollectionIdentifier(identifier) ||
        SHARED_PENDING_COLLECTION_VERBS.has(identifier) ||
        HANDROLLED_PENDING_STORES.includes(identifier) ||
        reportedCollections.has(collectionKey)
      )
        continue;
      reportedCollections.add(collectionKey);
      findings.push(
        `${label}:${lineOf(code, match.index)}: owns a pending-row collection ` +
          `(${identifier}) — replica ⊕ outbox is the one row store`
      );
    }
    const optimistic = code.match(/\boptimistic\??\s*:/u);
    if (optimistic?.index !== undefined)
      findings.push(
        `${label}:${lineOf(code, optimistic.index)}: supplies an app-owned ` +
          `optimistic mutation — pending-projection.ts is the one declaration door`
      );
    for (const reachPast of PENDING_ENGINE_REACH_PAST) {
      // A WHOLE NAME, not a substring. `GrantIntentQueue` is the grant plane's
      // own durable store — declared frame-level in `_shared` because the
      // authority plane is app-agnostic infrastructure (ruling V-replica),
      // which is exactly where this lane wants a shared declaration to be —
      // and a substring match read it as a reach into the outbox engine's
      // `IntentQueue`. An import clause still spells the bare name, so
      // aliasing cannot dodge the rule; only a DIFFERENT name passes, which is
      // what a different thing having a different name is for.
      const match = new RegExp(
        `\\b${escapeRegularExpression(reachPast)}\\b`,
        "u"
      ).exec(code);
      if (!match) continue;
      findings.push(
        `${label}:${lineOf(code, match.index)}: reaches into pending engine internal ` +
          `\`${reachPast}\` — pending-projection.ts is the app declaration door`
      );
    }
  }
  return findings;
}

export function checkPendingOverlay(root: string, files: SurfaceFile[]) {
  const findings = scanPendingOverlayFiles(files);
  for (const appId of PENDING_OVERLAY_APPS) {
    const appDir = path.join("packages", "blueprints", "apps", appId);
    const projection = path.join(appDir, "pending-projection.ts");
    const inline = path.join(appDir, "app-inline.tsx");
    if (!existsSync(path.join(root, projection))) {
      findings.push(`${projection}: missing pending projection declaration`);
      continue;
    }
    const inlineSource = readFileSync(path.join(root, inline), "utf8");
    if (!/\bpendingProjection\b/u.test(inlineSource))
      findings.push(`${inline}: does not register its pending projection`);
  }
  return findings;
}

// ─── ENGINE S — search status ────────────────────────────────────────────────
//
// `apps/_shared/search-scaffold.ts` owns the honest search states: resting /
// searching / ready / unreachable. The union is the WHOLE point of the engine —
// "unreachable" exists so a scope that could not be asked is never passed off
// as "no results" — and a second copy of it is a second answer to that
// question. `deriveSearchStatus` is the only thing allowed to produce one.
//
// TWO SHAPES OF FORK, AND THE HONEST LINE BETWEEN THEM:
//
//   * RE-DECLARING the union (a `type`/`const` naming all four states) outside
//     the scaffold. Always a fork, wherever it is.
//   * IMPORTING `SearchStatus` from something other than the scaffold. This one
//     is NOT automatically wrong: a module may RE-EXPORT the scaffold's type as
//     a local convenience (`apps/people/types.ts` does, and that is still one
//     owner — the type has a single declaration site). What the check forbids
//     is importing the name from a module that DECLARES its own. So the rule
//     resolves the specifier and asks which of the two it is.
//
// The consequence of drawing the line there: the three photos entries below
// clear together the moment `apps/photos/search.ts` re-exports instead of
// re-declaring. That is one edit, and it is the fix.

const SEARCH_SCAFFOLD_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "search-scaffold.ts"
);
const SEARCH_SCAFFOLD_SPECIFIER = /_shared\/search-scaffold(?:\.tsx?)?$/u;
const SEARCH_STATUS_STATES = ["resting", "searching", "ready", "unreachable"];

/** Ratchet — may shrink, never grow. Each entry states WHY it is still here.
 *  EMPTY since #883 B6: `apps/photos/search.ts` re-exports the scaffold's type
 *  instead of re-declaring it, which cleared its two importers with it — the
 *  one edit this lane's header said was the fix. */
const SEARCH_STATUS_RATCHET = new Map();

/** True when `file` re-exports the scaffold's `SearchStatus` rather than owning one. */
function reExportsSearchStatus(code: string) {
  return [
    ...code.matchAll(
      /export\s+(?:type\s+)?\{(?<clause>[^}]*)\}\s*from\s*["'](?<spec>[^"']+)["']/gu
    ),
  ].some(
    (m) =>
      /\bSearchStatus\b/u.test(m.groups?.clause ?? "") &&
      SEARCH_SCAFFOLD_SPECIFIER.test(
        (m.groups?.spec ?? "").replace(/\.tsx?$/u, "")
      )
  );
}

/** Every search-status fork in `files`, before the ratchet is applied. */
export function scanSearchStatusFiles(files: SurfaceFile[]) {
  const byLabel = new Map(files.map((file: SurfaceFile) => [file.label, file]));
  const findings: string[] = [];
  const report = (label: string, line: string, message: string) =>
    findings.push(`${label}:${line}: ${message}`);
  for (const { label, code } of files) {
    if (label === SEARCH_SCAFFOLD_PATH || /\.(?:test|spec)\./u.test(label))
      continue;
    // (a) a second declaration of the union.
    for (const m of code.matchAll(
      /\b(?:type|const|enum)\s+(?<name>[A-Za-z_$][\w$]*)\b[^;]{0,400}/gu
    )) {
      if (!SEARCH_STATUS_STATES.every((s) => m[0].includes(`"${s}"`))) continue;
      report(
        label,
        String(lineOf(code, m.index ?? 0)),
        `re-declares the search-status union as \`${m.groups?.name}\` — ` +
          `${SEARCH_SCAFFOLD_PATH} owns the four honest states, and a second copy ` +
          `is a second answer to "could this scope be asked at all"; import the ` +
          `type and call \`deriveSearchStatus\` instead`
      );
    }
    // (b) importing the name from a module that owns its own declaration.
    for (const m of code.matchAll(
      /import\s+(?:type\s+)?\{(?<clause>[^}]*)\}\s*from\s*["'](?<spec>[^"']+)["']/gu
    )) {
      if (!/\bSearchStatus\b/u.test(m.groups?.clause ?? "")) continue;
      const spec = m.groups?.spec;
      if (!spec) continue;
      if (SEARCH_SCAFFOLD_SPECIFIER.test(spec.replace(/\.tsx?$/u, "")))
        continue;
      if (!spec.startsWith(".")) continue; // a package specifier: not ours to resolve
      const resolvedBase = path.join(path.dirname(label), spec);
      const candidates = [
        resolvedBase,
        `${resolvedBase}.ts`,
        `${resolvedBase}.tsx`,
        path.join(resolvedBase, "index.ts"),
      ];
      // A sibling import inside `_shared` spells the owner `./search-scaffold.ts`,
      // which no specifier pattern can recognise — resolve and compare instead.
      if (candidates.includes(SEARCH_SCAFFOLD_PATH)) continue;
      const resolved = candidates
        .map((candidate) => byLabel.get(candidate))
        .find(Boolean);
      if (resolved && reExportsSearchStatus(resolved.code)) continue;
      report(
        label,
        String(lineOf(code, m.index ?? 0)),
        `imports \`SearchStatus\` from \`${spec}\`, which is not ` +
          `${SEARCH_SCAFFOLD_PATH} and does not re-export it — the type has one ` +
          `declaration site; import it from the scaffold, or make that module ` +
          `re-export the scaffold's type instead of owning a copy`
      );
    }
  }
  return findings;
}

export function checkSearchStatus(_root: string, files: SurfaceFile[]) {
  const byLabel = new Map(files.map((file: SurfaceFile) => [file.label, file]));
  const findings: string[] = [];
  const owner = byLabel.get(SEARCH_SCAFFOLD_PATH);
  // Anti-vacuity: every rule above is anchored on the scaffold still declaring
  // the union. If that file moves or is emptied, the whole gate passes silently.
  if (
    !owner ||
    !SEARCH_STATUS_STATES.every((state) => owner.code.includes(`"${state}"`))
  )
    findings.push(
      `${SEARCH_SCAFFOLD_PATH}: no longer declares the four search states — ` +
        `the search-status gate is anchored on this file and has gone vacuous`
    );
  const offenders = new Set();
  for (const finding of scanSearchStatusFiles(files)) {
    const ratcheted = [...SEARCH_STATUS_RATCHET.keys()].find((label) =>
      finding.startsWith(`${label}:`)
    );
    if (ratcheted) offenders.add(ratcheted);
    else findings.push(finding);
  }
  for (const [label, reason] of SEARCH_STATUS_RATCHET) {
    if (!byLabel.has(label))
      findings.push(
        `${label}: ratcheted as a search-status offender (${reason}) but the file is gone — drop the entry`
      );
    else if (!offenders.has(label))
      findings.push(
        `${label}: no longer forks the search-status union — remove it from ` +
          `SEARCH_STATUS_RATCHET so the gate closes behind you`
      );
  }
  return findings;
}

// ─── ENGINE E — selection ────────────────────────────────────────────────────
//
// `apps/_shared/selection-engine.ts` owns what a multi-select DOES: toggle one,
// extend a range from the anchor, select all, drop keys that no longer exist,
// and run a batch collecting per-target failures. Every one of those has a
// wrong version that looks right — a range that forgets the anchor after a
// filter change, a select-all that includes rows the member cannot see, a batch
// that stops at the first error and leaves the shelf half applied.
//
// So the rule is not "prefer the engine", it is: an APP TREE may not declare
// this machinery at all. Calling the engine's verbs is adoption and is fine;
// declaring or assigning one of those names locally is a second implementation.
// Both app trees are covered — the web blueprint and its mobile twin.

const SELECTION_ENGINE_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "selection-engine.ts"
);
const SELECTION_ENGINE_VERBS = [
  "buildSelectionActions",
  "toggleSelectionKey",
  "toggleSelectionRange",
  "toggleAllSelection",
  "pruneSelection",
  "runSelectionBatch",
];

/** Ratchet — may shrink, never grow. Each entry states WHY it is still here.
 *  EMPTY since #883 B6: Photos' adapter is `buildPhotoSelectionActions` and
 *  imports the engine's verb under the engine's own name, so the call site
 *  names which table of actions it is looking at. */
const SELECTION_RATCHET = new Map();

const APP_TREE_PREFIXES = [
  `${path.join("packages", "blueprints", "apps")}${path.sep}`,
  `${path.join("apps", "mobile", "src", "apps")}${path.sep}`,
];

/** Every app-local selection implementation in `files`, before the ratchet. */
export function scanSelectionFiles(files: SurfaceFile[]) {
  const findings: string[] = [];
  for (const { label, code } of files) {
    if (
      !APP_TREE_PREFIXES.some((prefix) => label.startsWith(prefix)) ||
      /\.(?:test|spec)\./u.test(label) ||
      label.includes(`${path.sep}_shared${path.sep}`)
    )
      continue;
    const body = maskStaticImports(code);
    for (const verb of SELECTION_ENGINE_VERBS) {
      // A declaration (`function f`, `const f =`) or a property/method bearing
      // the verb's name. A CALL — `runSelectionBatch(keys, …)` — matches
      // neither, which is exactly the adoption this gate wants to see.
      const declaration = new RegExp(
        `(?:function|const|let|var)\\s+${verb}\\b|\\b${verb}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\()`,
        "gu"
      );
      for (const m of body.matchAll(declaration))
        findings.push(
          `${label}:${lineOf(code, m.index)}: declares its own \`${verb}\` — ` +
            `${SELECTION_ENGINE_PATH} is the one selection engine; an app-local ` +
            `range toggle or select-all is a second answer to what the member ` +
            `just selected. Import the verb instead.`
        );
    }
  }
  return findings;
}

export function checkSelection(_root: string, files: SurfaceFile[]) {
  const findings: string[] = [];
  const owner = files.find(
    (file: SurfaceFile) => file.label === SELECTION_ENGINE_PATH
  );
  // Anti-vacuity: forbidding an app-local copy only means something while the
  // one shared implementation still exists and still exports every verb.
  if (owner) {
    for (const verb of SELECTION_ENGINE_VERBS) {
      if (
        !new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`, "u").test(
          owner.code
        )
      )
        findings.push(
          `${SELECTION_ENGINE_PATH}: no longer exports \`${verb}\` — either the ` +
            `engine lost a verb the apps depend on, or SELECTION_ENGINE_VERBS is stale`
        );
    }
  } else {
    findings.push(
      `${SELECTION_ENGINE_PATH}: missing — the selection gate forbids app-local ` +
        `copies of verbs that would then have no home`
    );
  }
  const offenders = new Set();
  for (const finding of scanSelectionFiles(files)) {
    const ratcheted = [...SELECTION_RATCHET.keys()].find((label) =>
      finding.startsWith(`${label}:`)
    );
    if (ratcheted) offenders.add(ratcheted);
    else findings.push(finding);
  }
  for (const [label] of SELECTION_RATCHET) {
    if (!offenders.has(label))
      findings.push(
        `${label}: no longer declares selection machinery — remove it from ` +
          `SELECTION_RATCHET so the gate closes behind you`
      );
  }
  return findings;
}
