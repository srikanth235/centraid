#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#738) one cross-tree scanner owns every shared-engine reach-past rule and its demonstrated-red pending-overlay tripwire
// ENGINE CONFORMANCE — one gate per shared engine (issue #712 E1).
//
// docs/blueprint-seats.md "Shared engines" says four things are built once and
// never per app: placement (A), custody (B), consent (C) and triage (D), plus
// the search scaffold and the refusal grammar. Each of those had a doc
// sentence and no mechanical check, so the only cost of ignoring one was a
// reviewer noticing. This file is that cost.
//
// WHY ONE SCRIPT RATHER THAN FOUR VITEST FILES. Every one of these rules is
// CROSS-TREE: the same law binds `packages/blueprints/apps/**` (browser ES
// modules), `apps/mobile/src/**` (Expo) and `packages/client/src/**` (the web
// shell), and no single vitest project sees all three. #686 already chose the
// lightweight `scripts/lint-*.mjs` + `check:push` route over authoring
// governance-kit directives for exactly this shape of rule; this follows that
// precedent. The two checks that ARE single-package stay where they are as
// vitest source scans and are NOT duplicated here:
//
//   * `packages/blueprints/src/placement-registry.test.ts` — A4 (the union
//     mirrors vault's `ShareableItemType`) and A7 inside the blueprints tree.
//   * `packages/blueprints/src/no-inference-client.test.ts` — the provider-SDK
//     half of C, widened in this pass to the mobile tree.
//
// EVERY CHECK IS A TRIPWIRE, NOT A PROOF. They read source text. An author
// determined to dodge one can compute a string. The point is to catch the
// ordinary "I copy-pasted the shape into my app" mistake.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  RAW_DIALOG_LEDGER,
  UNSTYLED_BUTTON_LEDGER,
  UNSTYLED_PRESSABLE_LEDGER,
} from "./component-existence-ledger.mjs";
import { blankComments, scanRefusalGrammar } from "./lib/disabled-controls.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo", ".next"]);

/** Every surface tree a blueprint app or a client shell lives in. */
const SOURCE_ROOTS = [
  path.join("packages", "blueprints", "apps"),
  path.join("packages", "client", "src"),
  path.join("apps", "mobile", "src"),
  path.join("apps", "web", "src"),
];

function walk(directory, out = []) {
  if (!existsSync(directory)) return out;
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) walk(absolute, out);
    else if (/\.(?:ts|tsx)$/u.test(absolute)) out.push(absolute);
  }
  return out;
}

/** Every scanned file, as `{ label, code }` with comments blanked (string
 *  bodies intact — these checks read attribute values). */
function surfaceFiles(root = ROOT) {
  const files = [];
  for (const rel of SOURCE_ROOTS) {
    for (const absolute of walk(path.join(root, rel))) {
      files.push({
        label: path.relative(root, absolute),
        code: blankComments(readFileSync(absolute, "utf8")),
      });
    }
  }
  return files;
}

/** Line number of a byte offset, 1-based. */
const lineOf = (code, index) => code.slice(0, index).split("\n").length;

/** Quoted literals out of a `const NAME = [...]` array, by source scan — the
 *  same technique `placement-registry.test.ts` uses on vault's closure. */
function literalArray(file, name) {
  const source = readFileSync(file, "utf8");
  // `= [` specifically — a type annotation may itself end in `[]`
  // (`readonly PlacementEntity[]`), so the opening bracket is found from the
  // assignment onwards, never from the declaration's start.
  const match = source.match(new RegExp(`const ${name}[^=]*=\\s*\\[`, "u"));
  if (!match) throw new Error(`${name} not found in ${file}`);
  const start = match.index + match[0].length - 1;
  const end = source.indexOf("];", start);
  if (end === -1)
    throw new Error(`${name} in ${file} has no \`];\` terminator`);
  const body = source.slice(start, end);
  return [...body.matchAll(/"(?<name>[^"]+)"/gu)].map((m) => m[1]);
}

// ─── ENGINE A — placement ────────────────────────────────────────────────────
//
// `apps/_shared/placement-registry.ts` is the ONE answer to "what can be
// placed into an audience vault, and which app owns it". The registry test
// already proves the union mirrors vault's minus `locker.item`; what nothing
// checked is the OTHER half — a placement UI built OUTSIDE the registry. Any
// surface naming an `itemType` the registry does not carry is that UI.
//
// SCOPED TO THE `itemType` SPELLING, deliberately. `"locker.item"` is a real
// row type that Approvals, the palette, the replica readers and Locker's own
// queries all name legitimately (`packages/client/src/react/shell/routes/
// approvalsData.ts`, `apps/locker/queries/*`) — a blanket ban on the string
// would be a ban on Locker existing. What A7 forbids is placing one, and the
// verb for that is exactly `itemType`.

const REGISTRY_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "placement-registry.ts"
);

function checkPlacement(root, files) {
  const registry = literalArray(
    path.join(root, REGISTRY_PATH),
    "PLACEMENT_REGISTRY"
  );
  // The registry literal interleaves itemType/appId/label; the item types are
  // the ones shaped `<domain>.<entity>`, which app ids and labels are not.
  const placeable = new Set(
    registry.filter((v) => /^[a-z_]+\.[a-z_]+$/u.test(v))
  );
  if (placeable.size === 0) {
    throw new Error(
      `${REGISTRY_PATH}: no itemType literals found — the scan drifted`
    );
  }
  const findings = [];
  for (const { label, code } of files) {
    if (label === REGISTRY_PATH) continue;
    for (const m of code.matchAll(
      /itemType["']?\s*[:=]\s*["'](?<t>[^"']+)["']/gu
    )) {
      const itemType = m.groups.t;
      if (placeable.has(itemType)) continue;
      // A7 gets its own sentence, because "locker.item is missing from the
      // registry" is a DECISION, not an omission someone should fix by
      // adding a row.
      findings.push(
        itemType === "locker.item"
          ? `${label}:${lineOf(code, m.index)}: passes \`locker.item\` as a ` +
              `placement itemType — a secret is the one thing v0 refuses to let ` +
              `a member place, and it is left out of PlaceableItemType on ` +
              `purpose (A7, see ${REGISTRY_PATH}'s header). Reopening this means ` +
              `arguing the case in that file, not widening a string here.`
          : `${label}:${lineOf(code, m.index)}: placement control names ` +
              `\`${itemType}\`, which is not in PLACEMENT_REGISTRY ` +
              `(${REGISTRY_PATH}) — a placement UI built outside the registry ` +
              `is the fourth hand-copied union A4 exists to prevent; add the ` +
              `entity to the registry or stop calling it a placement`
      );
    }
  }
  return findings;
}

// ─── ENGINE B — custody ──────────────────────────────────────────────────────
//
// `apps/mobile/src/kit/transfer/**` and `kit/storage/**` are the frame's door
// to moving and releasing bytes. `packages/blueprints/src/blueprint-seats.test.ts`
// gates the WEB blueprint tree (record-only apps may not import `kit/transfer`)
// and the mobile tree had no equivalent — so an app could reach past the frame
// straight into the sqlite ledger or the radio policy and nothing said a word.
//
// TWO CLASSES OF REACH-PAST, ENFORCED DIFFERENTLY:
//
//   * The custody PROJECTIONS (`blob_custody_state`, `blob.custody_rollup`).
//     `kit/storage/custody-status.ts` owns the read; no app may name either.
//     ZERO allowlist — this half is genuinely closed today.
//   * The transfer ENGINE internals (`lib/upload/native-queue`, `native-policy`).
//     `kit/transfer/transfer-queue.ts` and `transfer-policy.ts` own these.
//     Two Photos modules still reach them directly; they are a RATCHET, listed
//     with a reason, and the list may only shrink.
//
// NOT gated: `lib/upload/media-producer`, `enqueue`, `expo-native`,
// `native-digest`. Those are the PRODUCER side — an app handing bytes in — and
// are legitimately app-facing today (Docs' scans and Photos' saves both use
// them). If the frame ever owns a producer door too, they move up here.

const MOBILE_APPS = path.join("apps", "mobile", "src", "apps");

const CUSTODY_PROJECTIONS = ["blob_custody_state", "custody_rollup"];
const TRANSFER_INTERNALS = [
  "lib/upload/native-queue",
  "lib/upload/native-policy",
];

/** Ratchet — may shrink, never grow. Each entry states WHY it is still here. */
const TRANSFER_INTERNAL_RATCHET = new Map([
  [
    path.join(MOBILE_APPS, "photos", "timeline-engine.ts"),
    "reads the upload queue's rows to mark timeline tiles; the frame has no " +
      "per-asset queue projection yet (kit/transfer/transfer-queue.ts is a run readout)",
  ],
  [
    path.join(MOBILE_APPS, "photos", "photos-backup.ts"),
    "evaluates the radio policy for the in-app sweep; kit/transfer/transfer-policy.ts " +
      "owns the RECORD, and `lib/upload/native-policy.ts` still owns evaluation",
  ],
]);

function checkCustody(_root, files) {
  const findings = [];
  const appPrefix = `${MOBILE_APPS}${path.sep}`;
  for (const { label, code } of files) {
    if (!label.startsWith(appPrefix)) continue;
    for (const term of CUSTODY_PROJECTIONS) {
      for (const m of code.matchAll(new RegExp(term, "gu"))) {
        findings.push(
          `${label}:${lineOf(code, m.index)}: names the custody projection ` +
            `\`${term}\` — apps/mobile/src/kit/storage/custody-status.ts is the ` +
            `only door (docs/blueprint-seats.md "Shared engines")`
        );
      }
    }
    for (const term of TRANSFER_INTERNALS) {
      if (!code.includes(term)) continue;
      if (TRANSFER_INTERNAL_RATCHET.has(label)) continue;
      const index = code.indexOf(term);
      findings.push(
        `${label}:${lineOf(code, index)}: imports the transfer engine internal ` +
          `\`${term}\` — apps/mobile/src/kit/transfer/ is the frame's one door ` +
          `for moving bytes; an app that reaches past it owns a second policy`
      );
    }
  }
  // The ratchet may only shrink: a stale entry is a lie about the tree.
  for (const [label] of TRANSFER_INTERNAL_RATCHET) {
    const entry = files.find((f) => f.label === label);
    if (!entry) {
      findings.push(
        `${label}: ratcheted as a transfer-internal offender but the file is gone — drop the entry`
      );
      continue;
    }
    if (!TRANSFER_INTERNALS.some((t) => entry.code.includes(t))) {
      findings.push(
        `${label}: no longer reaches a transfer engine internal — remove it ` +
          `from TRANSFER_INTERNAL_RATCHET so the gate closes behind you`
      );
    }
  }
  return findings;
}

// ─── ENGINE C — consent ──────────────────────────────────────────────────────
//
// `apps/_shared/consent-gate.ts` types `domain` as `EnrichDomain`, so a Locker
// consent gate is already a TYPE error at the call site (C4). The type alone
// is not enough for one reason: the blueprint app tree carries its own ambient
// globals and is compiled by each shell's bundler, not by the package's own
// `tsc`, so a `domain="locker"` in an app `.tsx` can ship without a typechecker
// ever having an opinion. This is the check that has one.

const CONSENT_GATE_PATH = path.join(
  "packages",
  "blueprints",
  "apps",
  "_shared",
  "consent-gate.ts"
);

function checkConsent(root, files) {
  const domains = new Set(
    literalArray(path.join(root, CONSENT_GATE_PATH), "ENRICH_DOMAINS")
  );
  const findings = [];
  for (const { label, code } of files) {
    if (!/\bConsentGate\b/u.test(code)) continue;
    for (const m of code.matchAll(/\bdomain\s*[=:]\s*["'](?<d>[^"']+)["']/gu)) {
      if (domains.has(m.groups.d)) continue;
      findings.push(
        `${label}:${lineOf(code, m.index)}: consent gate constructed for domain ` +
          `\`${m.groups.d}\`, which is not an ENRICH_DOMAIN ` +
          `(${[...domains].join(" | ")}) — a domain with no \`enrich_policy\` ` +
          `row has no consent moment to ask for (C4, ${CONSENT_GATE_PATH})`
      );
    }
  }
  return findings;
}

// ─── ENGINE D — triage ───────────────────────────────────────────────────────
//
// One verb answers a face proposal: `media.answer_face_proposal`, with three
// answers. The `media.confirm_face` / `media.reject_face` pair it replaced is
// RETIRED, not deprecated-beside-it — `reject` was a DELETE, which is not a
// state, so the enricher could re-propose the same stranger for ever.
//
// The second half is the triage surfaces' own refusal grammar: a queue control
// that goes inert without saying why leaves the member stuck at "1 of 54" with
// no next move.

const RETIRED_TRIAGE_VERBS = ["media.confirm_face", "media.reject_face"];

const TRIAGE_SURFACES = [
  path.join(
    "packages",
    "blueprints",
    "apps",
    "photos",
    "components",
    "FaceReview.tsx"
  ),
  path.join(
    "packages",
    "blueprints",
    "apps",
    "photos",
    "components",
    "DuplicateReview.tsx"
  ),
  path.join("apps", "mobile", "src", "apps", "photos", "FaceReview.tsx"),
  path.join("apps", "mobile", "src", "apps", "photos", "DuplicateReview.tsx"),
];

/**
 * KNOWN GAPS, stated rather than silently excluded. Both are the SAME defect
 * in two clients: Face review's "Name →" goes inert when the library holds no
 * other named person, and neither client says so inline (web reaches for a
 * `title` tooltip, which "Shared engines" 5 forbids by name; native says
 * nothing at all). They are ratcheted rather than fixed here because
 * `apps/photos/**` in both trees is owned by a concurrent agent in this pass —
 * see the receipt. A NEW reasonless control in a triage surface still fails.
 */
const TRIAGE_REFUSAL_GAPS = new Set([
  `${path.join("packages", "blueprints", "apps", "photos", "components", "FaceReview.tsx")}:399`,
  `${path.join("apps", "mobile", "src", "apps", "photos", "FaceReview.tsx")}:522`,
  `${path.join("apps", "mobile", "src", "apps", "photos", "FaceReview.tsx")}:525`,
]);

function checkTriage(root, files) {
  const findings = [];
  for (const { label, code } of files) {
    for (const verb of RETIRED_TRIAGE_VERBS) {
      for (const m of code.matchAll(
        new RegExp(`["']${verb.replace(".", "\\.")}["']`, "gu")
      )) {
        findings.push(
          `${label}:${lineOf(code, m.index)}: calls the retired verb \`${verb}\` — ` +
            `\`media.answer_face_proposal\` is the one verb, with three answers ` +
            `(confirm / reject / dismiss); the pair was removed because "rejected" ` +
            `was a DELETE and so could never end a review queue`
        );
      }
    }
  }
  for (const rel of TRIAGE_SURFACES) {
    const absolute = path.join(root, rel);
    if (!existsSync(absolute)) continue;
    for (const finding of scanRefusalGrammar(
      readFileSync(absolute, "utf8"),
      rel
    )) {
      const site = finding.slice(0, finding.indexOf(":", rel.length + 1));
      if (TRIAGE_REFUSAL_GAPS.has(site)) continue;
      findings.push(finding);
    }
  }
  return findings;
}

// ─── THE REFUSAL GRAMMAR ─────────────────────────────────────────────────────
//
// SCOPED, AND SAID SO. A repo-wide "every disabled control states a reason"
// check produces ~44 findings on the mobile tree today, most of them controls
// where the refusal IS the label (a lightbox's previous-photo arrow on the
// first photo, a tile-size step at the smallest size). That gate would be
// noise, and noise gets suppressed rather than obeyed.
//
// So it runs over a NAMED list: the frame surfaces of the shared engines —
// where a refusal is a POLICY the member cannot see the shape of, and a
// missing sentence is a dead end rather than an obvious one.
//
// WHAT THIS DOES NOT COVER, on purpose: every other mobile screen
// (`Approvals`, `Capture`, `Settings`, `VaultsSwitcher`, …), the whole web
// blueprint tree except the triage surfaces above, and any refusal computed
// inside a child component. Widening it means first deciding what a paging
// arrow at the end of a list is supposed to say.

const REFUSAL_SURFACES = [
  path.join("apps", "mobile", "src", "kit", "components", "ConsentGate.tsx"),
  path.join("apps", "mobile", "src", "screens", "BackupHealth.tsx"),
  path.join("apps", "mobile", "src", "screens", "BackupHealth.custody.tsx"),
  path.join("apps", "mobile", "src", "screens", "PhoneStorage.tsx"),
];

function checkRefusalGrammar(root) {
  const findings = [];
  for (const rel of REFUSAL_SURFACES) {
    const absolute = path.join(root, rel);
    if (!existsSync(absolute)) {
      findings.push(
        `${rel}: named as a refusal surface but missing — fix the list`
      );
      continue;
    }
    findings.push(...scanRefusalGrammar(readFileSync(absolute, "utf8"), rel));
  }
  return findings;
}

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

function isPendingCollectionIdentifier(identifier) {
  const collection = identifier.replace(/^set(?=[A-Z])/u, "");
  return (
    PENDING_COLLECTION_STATE.test(collection) &&
    PENDING_COLLECTION_VALUE.test(collection)
  );
}

function maskStaticImports(code) {
  return code.replace(
    /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["'][^"']+["'];?/gu,
    (statement) => statement.replace(/[^\n]/gu, " ")
  );
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Reject an app-owned collection populated from a replica write result even
 * when every local identifier avoids pending/queued/overlay vocabulary. This
 * is the semantic hand-overlay shape #738 removes: durable query results are
 * the row store, so write acknowledgements must never be folded into hook
 * state for presentation.
 */
function writeBackedCollectionFindings(label, code) {
  const findings = [];
  const assignedWriteResults = [
    ...code.matchAll(
      /\b(?:const|let|var)\s+(?<result>[A-Za-z_$][\w$]*)\s*=\s*await\s+(?:window\.)?centraid\.write\s*\(/gu
    ),
  ].flatMap((match) => (match.groups?.result ? [match.groups.result] : []));
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

export function scanPendingOverlayFiles(files) {
  const findings = [];
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

function checkPendingOverlay(root, files) {
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
function reExportsSearchStatus(code) {
  return [
    ...code.matchAll(
      /export\s+(?:type\s+)?\{(?<clause>[^}]*)\}\s*from\s*["'](?<spec>[^"']+)["']/gu
    ),
  ].some(
    (m) =>
      /\bSearchStatus\b/u.test(m.groups.clause) &&
      SEARCH_SCAFFOLD_SPECIFIER.test(m.groups.spec.replace(/\.tsx?$/u, ""))
  );
}

/** Every search-status fork in `files`, before the ratchet is applied. */
export function scanSearchStatusFiles(files) {
  const byLabel = new Map(files.map((file) => [file.label, file]));
  const findings = [];
  const report = (label, line, message) =>
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
        lineOf(code, m.index),
        `re-declares the search-status union as \`${m.groups.name}\` — ` +
          `${SEARCH_SCAFFOLD_PATH} owns the four honest states, and a second copy ` +
          `is a second answer to "could this scope be asked at all"; import the ` +
          `type and call \`deriveSearchStatus\` instead`
      );
    }
    // (b) importing the name from a module that owns its own declaration.
    for (const m of code.matchAll(
      /import\s+(?:type\s+)?\{(?<clause>[^}]*)\}\s*from\s*["'](?<spec>[^"']+)["']/gu
    )) {
      if (!/\bSearchStatus\b/u.test(m.groups.clause)) continue;
      const spec = m.groups.spec;
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
        lineOf(code, m.index),
        `imports \`SearchStatus\` from \`${spec}\`, which is not ` +
          `${SEARCH_SCAFFOLD_PATH} and does not re-export it — the type has one ` +
          `declaration site; import it from the scaffold, or make that module ` +
          `re-export the scaffold's type instead of owning a copy`
      );
    }
  }
  return findings;
}

function checkSearchStatus(_root, files) {
  const byLabel = new Map(files.map((file) => [file.label, file]));
  const findings = [];
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
export function scanSelectionFiles(files) {
  const findings = [];
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

function checkSelection(_root, files) {
  const findings = [];
  const owner = files.find((file) => file.label === SELECTION_ENGINE_PATH);
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
const posix = (label) => label.split(path.sep).join("/");

/**
 * The full text of the opening tag beginning at `start`, read across lines and
 * ignoring `>` inside strings or JSX expression braces (`onClick={() => …}`),
 * so an attribute three lines down still counts as being on the tag.
 */
function openingTagText(code, start) {
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
export function countBareTags(code, tag, attribute) {
  let count = 0;
  for (const m of code.matchAll(new RegExp(`<${tag}[\\s>/]`, "gu"))) {
    if (attribute && attribute.test(openingTagText(code, m.index))) continue;
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
    scope: (label) =>
      !KIT_MODAL_OWNERS.has(label) &&
      WEB_SURFACE_PREFIXES.some((p) => label.startsWith(p)),
    count: (code) => countBareTags(code, "dialog", null),
    fix: "a kit modal owns focus trapping, the backdrop and the return of focus",
  },
  {
    name: "class-less <button>",
    ledger: UNSTYLED_BUTTON_LEDGER,
    scope: (label) => WEB_SURFACE_PREFIXES.some((p) => label.startsWith(p)),
    count: (code) =>
      countBareTags(code, "button", /\b(?:className|class)\s*=/u),
    fix: "kit Button already carries the target size, the token styling and the focus ring",
  },
  {
    name: "style-less <Pressable>",
    ledger: UNSTYLED_PRESSABLE_LEDGER,
    scope: (label) => label.startsWith("apps/mobile/src/"),
    count: (code) => countBareTags(code, "Pressable", /\bstyle\s*=/u),
    fix: "apps/mobile/src/kit/components/Tappable.tsx already carries the role, the hit slop that buys the touch floor, the press step and the disabled wiring",
  },
];

export function scanComponentExistence(files, lanes = COMPONENT_LEDGERS) {
  const findings = [];
  for (const { name, ledger, scope, count, fix } of lanes) {
    const seen = new Set();
    for (const { label, code } of files) {
      const key = posix(label);
      if (!scope(key) || /\.(?:test|spec)\./u.test(key)) continue;
      const actual = count(code);
      const budget = ledger[key] ?? 0;
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
export function scanActionKitFiles(files) {
  const findings = [];
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

function checkActionKit(_root, files) {
  const findings = [];
  const owner = files.find((file) => file.label === ACTION_KIT_PATH);
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
    (file) => BLUEPRINT_ACTION.test(file.label) && !/\.test\./u.test(file.label)
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
function blueprintAppFiles(root) {
  const dir = path.join(root, BUNDLED_APPS_DIR_NAME);
  return walk(dir).map((absolute) => ({
    label: path.relative(root, absolute),
    code: readFileSync(absolute, "utf8"),
  }));
}

/** Ratchet — may shrink, never grow. Seeded EMPTY: no copy is left. */
const SCHEME_URI_RATCHET = new Map();

/** Every scheme URI spelled outside the kit, before the ratchet. */
export function scanConceptSchemeFiles(files, kitLabel = SCHEME_KIT_PATH) {
  const kit = files.find((file) => file.label === kitLabel);
  const owned = kit
    ? [...kit.code.matchAll(SCHEME_URI_DECLARATION)].map((m) =>
        m.groups.uri.slice(1, -1)
      )
    : [];
  const findings = [];
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
      if (reported.has(m.groups.uri)) continue;
      findings.push(
        `${label}:${lineOf(code, m.index)}: names the concept scheme ` +
          `\`${m.groups.uri}\`, which ${kitLabel} does not carry — add it there and ` +
          `import it, rather than starting a second copy of the vocabulary`
      );
    }
  }
  return findings;
}

function checkConceptSchemes(root) {
  const files = blueprintAppFiles(root);
  const findings = [];
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

// ─── ENGINE W — declared writes ──────────────────────────────────────────────
//
// `app.json`'s `writes:` is the action's claim about which vault tables its
// command touches, and every one of the 131 was an empty array — a claim of
// nothing, which is neither true nor checkable. #883 filled them from the
// commands themselves; this lane keeps them honest in the two ways a text file
// goes wrong: a name that is not a vault entity at all (a typo, or a table
// dropped from the ontology — `tally.expense_receipt` and the `home.*` /
// `business.*` domains went this wave), and an action that quietly goes back
// to declaring nothing.
//
// NOT CHECKED HERE: declared ⊇ observed. That comparison needs the running
// vault, so it belongs to a server-side gate over receipts, not to a text
// scanner. What this lane guarantees that gate is a well-formed left-hand side.
//
// The vault's own registry is the vocabulary; it is read by source scan for the
// same reason `placement-registry.test.ts` reads vault's `ShareableItemType`
// that way — a blueprint may not import vault, and the alternative is a third
// copy of the table list.

const VAULT_TABLES_PATH = path.join(
  "packages",
  "vault",
  "src",
  "schema",
  "entity-catalog.ts"
);
/**
 * An action whose command writes NO vault row, with the reason. Ledger, not
 * exemption: an entry whose action starts writing something fails, and so does
 * an empty `writes:` that is not listed.
 */
const WRITES_NONE_LEDGER = new Map([
  [
    "locker/export",
    "`locker.export` unseals and hands back a payload; the only durable trace " +
      "it leaves is the reveal receipt, which is the journal's row, not a vault one",
  ],
]);

/**
 * Every `schema.table` in vault's canonical registry, by source scan.
 *
 * READS THE DECLARATIONS, NOT THE DERIVED VIEWS. `VAULT_TABLES` and
 * `JOURNAL_TABLES` are `tableNamesOf(VAULT_ENTITIES)` since #883's O-label
 * rung — the registry grew a per-entity label and the bare-name views became
 * a projection of it — so a scan looking for `schema: ["a", "b"]` literals
 * found nothing and this whole lane went vacuous behind its own anti-vacuity
 * guard. The entity registries are the one place a table is added or removed,
 * which is what a text scanner has to read.
 *
 * The shape is `schema: { table: { label, blurb? }, … }`, so the walk is one
 * brace level deeper than the old one: schema keys at depth 1, table keys at
 * depth 2, and nothing below that (a label is a string, not a nested object).
 */
export function vaultEntityNames(root = ROOT) {
  const source = blankComments(
    readFileSync(path.join(root, VAULT_TABLES_PATH), "utf8")
  );
  const names = new Set();
  for (const constant of ["VAULT_ENTITIES", "JOURNAL_ENTITIES"]) {
    const start = source.indexOf(`export const ${constant}`);
    if (start === -1) continue;
    const open = source.indexOf("{", start);
    let depth = 0;
    let schema = null;
    for (let i = open; i < source.length; i++) {
      const char = source[i];
      if (char === '"' || char === "'" || char === "`") {
        // A label's own braces would otherwise be counted as structure.
        const quote = char;
        for (i++; i < source.length; i++) {
          if (source[i] === "\\") i++;
          else if (source[i] === quote) break;
        }
        continue;
      }
      if (char === "{") {
        depth++;
        continue;
      }
      if (char === "}") {
        if (--depth === 0) break;
        if (depth === 1) schema = null;
        continue;
      }
      // A key sits immediately before its `:` at the depth it belongs to.
      const key = /^(?<name>[A-Za-z_][\w]*)\s*:/u.exec(source.slice(i));
      if (!key) continue;
      if (depth === 1) schema = key.groups.name;
      else if (depth === 2 && schema) names.add(`${schema}.${key.groups.name}`);
      i += key[0].length - 1;
    }
  }
  return names;
}

function checkDeclaredWrites(root) {
  const findings = [];
  const entities = vaultEntityNames(root);
  // Anti-vacuity: an empty or tiny vocabulary would pass every declaration.
  // Floor is 90, not 100: post-#929 catalog after the commons rail left
  // (~14 share.commons_* tables gone; share.subscription + lineage added).
  if (entities.size < 90 || !entities.has("core.content_item"))
    return [
      `${VAULT_TABLES_PATH}: read ${entities.size} entity names — the declared-writes ` +
        `gate is anchored on this registry and has gone vacuous`,
    ];
  const appsDir = path.join(root, BUNDLED_APPS_DIR_NAME);
  const seen = new Set();
  const apps = existsSync(appsDir)
    ? readdirSync(appsDir).filter(
        (name) =>
          !name.startsWith("_") &&
          existsSync(path.join(appsDir, name, "app.json"))
      )
    : [];
  if (apps.length < 8)
    findings.push(
      `${BUNDLED_APPS_DIR_NAME}: found ${apps.length} bundled manifests — the ` +
        `declared-writes lane's walk drifted from the layout`
    );
  for (const app of apps.toSorted()) {
    const rel = path.join(BUNDLED_APPS_DIR_NAME, app, "app.json");
    const manifest = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    for (const action of manifest.actions ?? []) {
      const key = `${app}/${action.name}`;
      const writes = action.writes;
      if (!Array.isArray(writes)) {
        findings.push(
          `${rel}: action \`${action.name}\` declares no \`writes\` array — ` +
            `every action names the vault tables its command writes`
        );
        continue;
      }
      for (const table of writes) {
        if (entities.has(table)) continue;
        findings.push(
          `${rel}: action \`${action.name}\` declares \`${table}\`, which is not ` +
            `a vault entity (${VAULT_TABLES_PATH}) — a dropped table or a typo ` +
            `reads as a write that can never happen`
        );
      }
      if (writes.length > 0) continue;
      seen.add(key);
      const reason = WRITES_NONE_LEDGER.get(key);
      if (!reason)
        findings.push(
          `${rel}: action \`${action.name}\` declares \`writes: []\` — trace the ` +
            `command it dispatches and name the tables, or add it to ` +
            `WRITES_NONE_LEDGER with the reason it writes nothing`
        );
    }
  }
  for (const [key, reason] of WRITES_NONE_LEDGER) {
    if (!seen.has(key))
      findings.push(
        `${key}: ledgered as writing nothing (${reason}) but it now declares ` +
          `writes, or the action is gone — drop the WRITES_NONE_LEDGER entry`
      );
  }
  return findings;
}

// ─── driver ──────────────────────────────────────────────────────────────────

/** Every engine's findings, keyed by engine. Exported for the test. */
export function scanEngineConformance(root = ROOT) {
  const files = surfaceFiles(root);
  if (files.length < 200) {
    throw new Error(
      `only ${files.length} surface files found — SOURCE_ROOTS drifted from the layout`
    );
  }
  return {
    "A placement": checkPlacement(root, files),
    "B custody": checkCustody(root, files),
    "C consent": checkConsent(root, files),
    "D triage": checkTriage(root, files),
    "H pending overlay": checkPendingOverlay(root, files),
    "S search status": checkSearchStatus(root, files),
    "E selection": checkSelection(root, files),
    "K action kit": checkActionKit(root, files),
    "V concept schemes": checkConceptSchemes(root),
    "W declared writes": checkDeclaredWrites(root),
    "component existence": scanComponentExistence(files),
    "refusal grammar": checkRefusalGrammar(root),
  };
}

function main() {
  const byEngine = scanEngineConformance();
  const failed = Object.entries(byEngine).filter(([, f]) => f.length > 0);
  if (failed.length > 0) {
    console.error("FAIL — engine conformance (docs/blueprint-seats.md):");
    for (const [engine, findings] of failed) {
      console.error(`  engine ${engine}:`);
      for (const finding of findings) console.error(`    ${finding}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "ok   engine conformance — placement, custody, consent, triage, pending overlay, " +
      "search status, selection, the action kit and the concept-scheme vocabulary each " +
      "have exactly one door, every bundled action names the vault tables it writes, the " +
      "component-existence ledger has not grown, and the engine surfaces explain every refusal"
  );
}

if (process.argv[1] === import.meta.filename) main();
