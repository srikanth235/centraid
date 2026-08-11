import assert from "node:assert/strict";
import test from "node:test";

import {
  IN_FLIGHT_FLAGS,
  SELECTED_STATE_FLAGS,
  scanRefusalGrammar,
} from "./lib/disabled-controls.mjs";
import {
  scanEngineConformance,
  scanPendingOverlayFiles,
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
    "H pending overlay",
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
