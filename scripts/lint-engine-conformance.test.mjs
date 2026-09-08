import assert from "node:assert/strict";
import test from "node:test";

import {
  IN_FLIGHT_FLAGS,
  SELECTED_STATE_FLAGS,
  scanRefusalGrammar,
} from "./lib/disabled-controls.mjs";
import {
  countBareTags,
  scanActionKitFiles,
  scanComponentExistence,
  scanConceptSchemeFiles,
  scanEngineConformance,
  scanPendingOverlayFiles,
  scanSearchStatusFiles,
  scanSelectionFiles,
  vaultEntityNames,
} from "./lint-engine-conformance.mjs";

// The gate over the real tree. Every engine is green today; this is the
// assertion the sabotage runs were checked against.
test("every shared engine conforms in the real tree", () => {
  for (const [engine, findings] of Object.entries(scanEngineConformance())) {
    assert.deepEqual(findings, [], `engine ${engine}`);
  }
});

test("all shared engines are actually checked — no silently empty check", () => {
  assert.deepEqual(Object.keys(scanEngineConformance()).toSorted(), [
    "A placement",
    "B custody",
    "C consent",
    "D triage",
    "E selection",
    "H pending overlay",
    "K action kit",
    "S search status",
    "V concept schemes",
    "W declared writes",
    "component existence",
    "refusal grammar",
  ]);
});

test("pending overlay gate rejects both a hand store and an inline mutation", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "packages/blueprints/apps/tasks/Bad.tsx",
      code: "const pendingAdds = []; write({ optimistic: [] });",
    },
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /replica ⊕ outbox/u);
  assert.match(findings[1], /one declaration door/u);
});

test("pending overlay gate rejects a newly named local row collection", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "apps/mobile/src/apps/tasks/Bad.tsx",
      code: "const [pendingRows, setPendingRows] = useState([]);",
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /one row store/u);
});

test("pending overlay vocabulary tripwire covers properties and class fields", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "packages/blueprints/apps/tasks/Bad.tsx",
      code: `const queuedRows = [];
        class Cache { localOverlayRows = []; }
        cache.localOverlayRows.push(row);`,
    },
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /queuedRows/u);
  assert.match(findings[1], /localOverlayRows/u);
});

test("pending overlay gate permits importing the shared engine's row verb", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "packages/blueprints/apps/tally/logic.ts",
      code: `import { enrichPendingRows } from "../_shared/pending-overlay";
        const enriched = enrichPendingRows(rows, commons);`,
    },
  ]);
  assert.deepEqual(findings, []);
});

test("pending overlay boundary is independent of an app store's chosen name", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "packages/blueprints/apps/tasks/Bad.tsx",
      code: `import { IntentQueue } from "@centraid/client/replica/intents";
        const stagedEntities = [];
        new IntentQueue(stagedEntities);`,
    },
  ]);
  assert.equal(findings.length, 2);
  assert.match(findings[0], /IntentQueue/u);
  assert.match(findings[1], /replica\/intents/u);
});

test("pending overlay gate rejects arbitrary hook state fed by a write result", () => {
  const findings = scanPendingOverlayFiles([
    {
      label: "packages/blueprints/apps/tasks/Bad.tsx",
      code: `const [stagedEntities, setStagedEntities] = useState([]);
        const result = await window.centraid.write("tasks", {
          action: "add", input: { title: "Offline" }
        });
        setStagedEntities([...stagedEntities, result]);`,
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /stagedEntities/u);
  assert.match(findings[0], /one row store/u);
});

// ── the action-kit gate, driven with fixtures ────────────────────────────────

const ACTION = "packages/blueprints/apps/tasks/actions/probe.ts";

test("action-kit gate rejects a hand-rolled error taxonomy", () => {
  const findings = scanActionKitFiles([
    {
      label: ACTION,
      code: `export default async function probe({ body, ctx }) {
        try {
          return { status: 200, body: await ctx.vault.invoke({ command: "schedule.delete_task" }) };
        } catch (error) {
          return { status: 200, body: { status: "denied", reason: error.message } };
        }
      }`,
    },
  ]);
  // No kit import, a catch statement of its own, and the taxonomy's own word.
  assert.equal(findings.length, 3);
  assert.match(findings[0], /does not import/u);
  assert.match(findings[1], /catches its own vault error/u);
  assert.match(findings[2], /spells the outcome/u);
});

test("action-kit gate passes an adopter, `.catch` on a best-effort promise included", () => {
  // Notes' send-to-tasks shape: the backlink is deliberately best-effort, and
  // swallowing ITS failure is not a second error taxonomy.
  assert.deepEqual(
    scanActionKitFiles([
      {
        label: ACTION,
        code: `import { runVaultAction } from "../../_shared/action-kit.ts";
          export default async function probe({ body, ctx }) {
            return runVaultAction(ctx, { command: "schedule.add_task", input: {} }, async () => {
              await ctx.vault.invoke({ command: "core.link_entities" }).catch(() => undefined);
            });
          }`,
      },
    ]),
    []
  );
});

test("action-kit gate leaves queries, tests and non-blueprint trees alone", () => {
  assert.deepEqual(
    scanActionKitFiles([
      {
        label: "packages/blueprints/apps/tasks/queries/board.ts",
        code: 'try { x(); } catch (e) { return { status: "denied" }; }',
      },
      {
        label: "packages/blueprints/apps/tasks/actions/probe.test.ts",
        code: 'try { x(); } catch (e) { return { status: "denied" }; }',
      },
      {
        label: "apps/mobile/src/apps/tasks/actions/probe.ts",
        code: 'try { x(); } catch (e) { return { status: "denied" }; }',
      },
    ]),
    []
  );
});

// ── the concept-scheme gate, driven with fixtures ────────────────────────────

const SCHEME_KIT = "packages/blueprints/apps/_shared/concept-scheme-kit.ts";
const SCHEME_KIT_FILE = {
  label: SCHEME_KIT,
  code: `export const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
    export const RELATIONS_SCHEME_URI = "urn:duaility:relations";`,
};

test("concept-scheme gate rejects a second copy of a URI the kit owns", () => {
  const findings = scanConceptSchemeFiles(
    [
      SCHEME_KIT_FILE,
      {
        label: "packages/blueprints/apps/people/queries/people.ts",
        code: 'const FLAGS = "https://centraid.dev/schemes/flags";',
      },
    ],
    SCHEME_KIT
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /spells the concept-scheme URI/u);
  assert.match(findings[0], /one owner/u);
});

test("concept-scheme gate rejects a scheme the kit does not carry yet", () => {
  // The half that keeps the vocabulary from forking again: a NEW scheme
  // spelled in an app is a copy nobody has had the chance to duplicate yet.
  const findings = scanConceptSchemeFiles(
    [
      SCHEME_KIT_FILE,
      {
        label: "packages/blueprints/apps/notes/moods.ts",
        code: 'const MOODS = "https://centraid.dev/schemes/moods";',
      },
    ],
    SCHEME_KIT
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /does not carry/u);
});

test("concept-scheme gate passes an importer and ignores other trees", () => {
  assert.deepEqual(
    scanConceptSchemeFiles(
      [
        SCHEME_KIT_FILE,
        {
          label: "packages/blueprints/apps/docs/queries/drive.ts",
          code: 'import { FLAGS_SCHEME_URI } from "../../_shared/concept-scheme-kit.ts";',
        },
        {
          label: "apps/mobile/src/apps/docs/docs-projection.ts",
          code: 'const FLAGS = "https://centraid.dev/schemes/flags";',
        },
      ],
      SCHEME_KIT
    ),
    []
  );
});

// ── the declared-writes vocabulary ───────────────────────────────────────────

test("the vault entity registry is read whole, not partially", () => {
  // The declared-writes lane compares every `writes:` entry against this set;
  // a scan that drifted to a handful of names would pass anything.
  const names = vaultEntityNames();
  assert.ok(names.size >= 90, `only ${names.size} entities`);
  for (const entity of [
    "core.content_item",
    "schedule.task",
    "locker.item_passkey",
    "share.authority",
    "share.subscription",
    "share.subscription_lineage",
  ])
    assert.ok(names.has(entity), entity);
  // Retired this wave — a stale name would pass a declaration that cannot happen.
  for (const gone of [
    "tally.expense_receipt",
    "social.contact_card",
    "share.commons_op",
  ])
    assert.ok(!names.has(gone), gone);
});

// ── the search-status gate, driven with fixtures ─────────────────────────────

const SCAFFOLD = "packages/blueprints/apps/_shared/search-scaffold.ts";
const SCAFFOLD_FILE = {
  label: SCAFFOLD,
  code: 'export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";',
};

test("search-status gate rejects a second declaration of the four states", () => {
  const findings = scanSearchStatusFiles([
    SCAFFOLD_FILE,
    {
      label: "packages/blueprints/apps/tally/search.ts",
      code: 'export type LedgerStatus = "resting" | "searching" | "ready" | "unreachable";',
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /re-declares the search-status union/u);
  assert.match(findings[0], /LedgerStatus/u);
});

test("search-status gate ignores a partial state set — three is not the union", () => {
  assert.deepEqual(
    scanSearchStatusFiles([
      SCAFFOLD_FILE,
      {
        label: "packages/blueprints/apps/tally/phase.ts",
        code: 'type Phase = "resting" | "searching" | "ready";',
      },
    ]),
    []
  );
});

test("search-status gate rejects importing the type through a re-declaring module", () => {
  const findings = scanSearchStatusFiles([
    SCAFFOLD_FILE,
    {
      label: "packages/blueprints/apps/photos/search.ts",
      // The declaration itself is reported separately; this asserts the
      // IMPORTER is caught too, because it is consuming the wrong owner.
      code: 'export type SearchStatus = "resting" | "searching" | "ready" | "unreachable";',
    },
    {
      label: "packages/blueprints/apps/photos/components/Shelf.tsx",
      code: 'import type { SearchStatus } from "../search.ts";',
    },
  ]);
  assert.equal(findings.length, 2);
  assert.ok(
    findings.some((f) => /Shelf\.tsx:1: imports `SearchStatus`/u.test(f))
  );
});

test("search-status gate permits importing through a module that re-exports the scaffold's type", () => {
  // One declaration site, one owner: `apps/people/types.ts` does exactly this.
  assert.deepEqual(
    scanSearchStatusFiles([
      SCAFFOLD_FILE,
      {
        label: "packages/blueprints/apps/people/types.ts",
        code: 'export type { SearchStatus } from "../_shared/search-scaffold.ts";',
      },
      {
        label: "packages/blueprints/apps/people/components/Roster.tsx",
        code: 'import type { SearchStatus } from "../types.ts";',
      },
    ]),
    []
  );
});

test("search-status gate permits the sibling import inside _shared", () => {
  assert.deepEqual(
    scanSearchStatusFiles([
      SCAFFOLD_FILE,
      {
        label: "packages/blueprints/apps/_shared/SearchScaffold.tsx",
        code: 'import type { SearchStatus } from "./search-scaffold.ts";',
      },
    ]),
    []
  );
});

// ── the selection gate, driven with fixtures ─────────────────────────────────

test("selection gate rejects an app-local select-all", () => {
  const findings = scanSelectionFiles([
    {
      label: "apps/mobile/src/apps/docs/DocsPicker.tsx",
      code: `function toggleAllSelection(keys, all) {
        return keys.length === all.length ? [] : all;
      }`,
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /declares its own `toggleAllSelection`/u);
  assert.match(findings[0], /one selection engine/u);
});

test("selection gate rejects a range toggle assigned as a property", () => {
  const findings = scanSelectionFiles([
    {
      label: "packages/blueprints/apps/notes/shelf.ts",
      code: "const handlers = { toggleSelectionRange: (keys, from, to) => keys };",
    },
  ]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /toggleSelectionRange/u);
});

test("selection gate permits importing and CALLING the engine's verbs", () => {
  assert.deepEqual(
    scanSelectionFiles([
      {
        label: "packages/blueprints/apps/photos/selection.tsx",
        code: `import { pruneSelection, toggleAllSelection } from "../_shared/selection-engine.ts";
          const next = toggleAllSelection(keys, visible);
          replaceKeys(pruneSelection(next, live));`,
      },
    ]),
    []
  );
});

test("selection gate leaves _shared and test files alone", () => {
  assert.deepEqual(
    scanSelectionFiles([
      {
        label: "packages/blueprints/apps/_shared/selection-engine.ts",
        code: "export function pruneSelection(keys, live) { return keys; }",
      },
      {
        label: "packages/blueprints/apps/notes/shelf.test.ts",
        code: "function runSelectionBatch(keys) { return keys; }",
      },
    ]),
    []
  );
});

// ── the component-existence ledger, driven with fixtures ─────────────────────

test("an opening tag is read across lines, braces and strings", () => {
  const spread = `<button
      onClick={() => close({ hard: true })}
      aria-label="Close >"
      className={styles.close}
    >`;
  assert.equal(
    countBareTags(spread, "button", /\b(?:className|class)\s*=/u),
    0
  );
  assert.equal(
    countBareTags(
      spread.replace("className={styles.close}", 'id="close"'),
      "button",
      /\b(?:className|class)\s*=/u
    ),
    1
  );
});

test("an HTML-string button carrying `class` is not counted as unstyled", () => {
  assert.equal(
    countBareTags(
      '`<button type="button" class="kit-ask-btn">Ask</button>`',
      "button",
      /\b(?:className|class)\s*=/u
    ),
    0
  );
});

const BUTTON_LANE = (ledger) => [
  {
    name: "class-less <button>",
    ledger,
    scope: (label) => label.startsWith("packages/client/src/"),
    count: (code) =>
      countBareTags(code, "button", /\b(?:className|class)\s*=/u),
    fix: "kit Button already carries the target size",
  },
];

test("component-existence ledger rejects an instance it does not carry", () => {
  const findings = scanComponentExistence(
    [
      {
        label: "packages/client/src/react/New.tsx",
        code: "<button onClick={go}/>",
      },
    ],
    BUTTON_LANE({})
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /1 class-less <button> where the ledger allows 0/u);
  assert.match(findings[0], /tighten-only/u);
});

test("component-existence ledger also rejects an uncounted CLEANUP", () => {
  // The half that makes it a ratchet rather than a cap: fixing one instance
  // without lowering the number leaves the ledger lying about the tree.
  const findings = scanComponentExistence(
    [
      {
        label: "packages/client/src/react/Old.tsx",
        code: '<button className="x"/>',
      },
    ],
    BUTTON_LANE({ "packages/client/src/react/Old.tsx": 1 })
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /0 class-less <button> but the ledger still claims 1/u
  );
  assert.match(findings[0], /lower the count/u);
});

test("component-existence ledger rejects an entry whose file is gone", () => {
  const findings = scanComponentExistence(
    [],
    BUTTON_LANE({ "packages/client/src/react/Deleted.tsx": 1 })
  );
  assert.equal(findings.length, 1);
  assert.match(
    findings[0],
    /listed in the class-less <button> ledger but carries none/u
  );
});

test("component-existence ledger passes at exactly the seeded count", () => {
  assert.deepEqual(
    scanComponentExistence(
      [
        {
          label: "packages/client/src/react/Old.tsx",
          code: "<button onClick={a}/><button onClick={b}/>",
        },
        { label: "packages/client/src/react/Old.test.tsx", code: "<button/>" },
        { label: "apps/mobile/src/kit/Out.tsx", code: "<button/>" },
      ],
      BUTTON_LANE({ "packages/client/src/react/Old.tsx": 2 })
    ),
    []
  );
});

// ── the refusal-grammar scanner, driven with fixtures ────────────────────────

test("a control disabled by a structural condition with no reason fails", () => {
  const findings = scanRefusalGrammar(
    `<Pressable disabled={people.length === 0} onPress={name}>
       <Text>Name →</Text>
     </Pressable>`,
    "fixture.tsx"
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.tsx:1/u);
  assert.match(findings[0], /states no reason/u);
});

test("the same control passes once it carries an accessibilityHint", () => {
  assert.deepEqual(
    scanRefusalGrammar(
      `<Pressable
         accessibilityHint="No one else is named in your library yet"
         disabled={people.length === 0}
       />`,
      "fixture.tsx"
    ),
    []
  );
});

test("a reason rendered beside the control counts", () => {
  assert.deepEqual(
    scanRefusalGrammar(
      `{onDevice.reason ? <Text>{onDevice.reason}</Text> : null}
       <Pressable disabled={!deviceReady} />`,
      "fixture.tsx"
    ),
    []
  );
});

test("an in-flight flag alone is exempt — the label already says it", () => {
  assert.deepEqual(
    scanRefusalGrammar(`<Pressable disabled={busy || sending} />`, "f.tsx"),
    []
  );
  assert.ok(IN_FLIGHT_FLAGS.includes("busy"));
});

test("a selected-state flag alone is exempt — it is not a refusal", () => {
  assert.deepEqual(
    scanRefusalGrammar(`<button disabled={kept} />`, "f.tsx"),
    []
  );
  assert.ok(SELECTED_STATE_FLAGS.includes("kept"));
});

test("an in-flight flag mixed with a structural one still fails", () => {
  // This is the shape that hides real refusals: `busy || people.length === 0`
  // reads as an in-flight guard at a glance and is not one.
  assert.equal(
    scanRefusalGrammar(
      `<Pressable disabled={busy || people.length === 0} />`,
      "f.tsx"
    ).length,
    1
  );
});

test("a generic primitive forwarding its own `disabled` prop is exempt", () => {
  // `kit/components/Button.tsx` — the reason belongs at the call site that
  // computed the refusal, not inside the thing that paints it.
  assert.deepEqual(
    scanRefusalGrammar(
      `<Pressable accessibilityState={{ disabled }} onPress={onPress} />`,
      "f.tsx"
    ),
    []
  );
});

test("accessibilityState={{disabled:...}} is caught on its own", () => {
  // A control can go inert for a screen reader without ever spelling
  // `disabled=` — the a11y state is the whole refusal in that case.
  assert.equal(
    scanRefusalGrammar(
      `<Pressable accessibilityState={{ disabled: quotaExceeded }} />`,
      "f.tsx"
    ).length,
    1
  );
});

test("comments do not count as an explanation to the member", () => {
  // The duplicate-review row carried its reason in a `//` comment for months.
  // A comment is a note to the next author, not a sentence the member reads.
  assert.equal(
    scanRefusalGrammar(
      `// inert because the vault is read-only for this member — reason
       <button disabled={readOnly} />`,
      "f.tsx"
    ).length,
    1
  );
});
