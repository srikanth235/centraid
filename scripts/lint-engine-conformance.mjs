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
      const index = code.indexOf(reachPast);
      if (index === -1) continue;
      findings.push(
        `${label}:${lineOf(code, index)}: reaches into pending engine internal ` +
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
    "ok   engine conformance — placement, custody, consent, triage and pending overlay each " +
      "have exactly one door, and the engine surfaces explain every refusal"
  );
}

if (process.argv[1] === import.meta.filename) main();
