// THE AUTOMATIONS PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020,
// wave 4 lane automations, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `tests/**` that makes a v0 suite read `contracts/` files
// (#1020, Execution plan → Invariants). It adds no product code and changes no
// v0 behaviour.
//
// It lives under `tests/` for the reason Tally's and Photos' adapters record:
// `packages/*/tsconfig.test.json` sets `rootDir: "."`, so a file there cannot
// import both `contracts/tools/` and the v0 modules it invokes, and `tests/`'s
// own tsconfig already spans the repository.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the five
// files under `contracts/automations/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed.
//
// THE COMPARISON IS STRUCTURAL, NOT BYTE-FOR-BYTE, and the reason is
// `oxfmt`: the committed JSON is oxfmt's (it collapses short arrays onto one
// line), so a byte comparison against the generator's own `JSON.stringify`
// would fail on formatting for ever. What must not drift is the CONTENT, and
// that is what this asserts. Byte-level idempotency is still proved, by the
// documented regeneration loop:
//
//     CENTRAID_WRITE_CONTRACTS=1 node node_modules/vitest/vitest.mjs run \
//       tests/quality/automations-parity.contract.test.ts
//     bun run format && git diff --exit-code contracts/automations
//
// THE HOST ZONE IS PINNED TO UTC for the run, because v0's third cron
// resolution tier reads the host clock and a fixture whose bytes depend on the
// machine that generated it is not a fixture. That is also the finding this
// bundle carries: see `cron-cases.json`'s `finding` block.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUTOMATIONS_PARITY_DIR,
  AUTOMATIONS_PARITY_FILES,
  buildAutomationsParity,
  payloadsFor,
} from "../../contracts/tools/export-automations-parity.js";

const ROOT = path.join(import.meta.dirname, "..", "..");
const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

describe("contracts/automations", () => {
  it("is what the v0 automation modules answer", async () => {
    const bundle = await buildAutomationsParity();
    const payloads = payloadsFor(bundle);

    for (const file of AUTOMATIONS_PARITY_FILES) {
      const target = path.join(ROOT, AUTOMATIONS_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
        continue;
      }
      const committed: unknown = JSON.parse(readFileSync(target, "utf8"));
      expect(
        JSON.parse(payloads[file]),
        `${AUTOMATIONS_PARITY_DIR}/${file} is stale — re-run with CENTRAID_WRITE_CONTRACTS=1`
      ).toStrictEqual(committed);
    }
  });

  // The generator's own shape, asserted so a silently empty bundle cannot pass
  // the equality check above by being equally empty on both sides.
  it("covers every field form, every trigger kind and the whole gate grid", async () => {
    const bundle = await buildAutomationsParity();
    expect(bundle.cronCases.cases.length).toBeGreaterThan(2000);
    expect(
      new Set(bundle.cronCases.cases.map((entry) => entry.zone)).size
    ).toBe(5);
    // Every expression appears, including the three that must never match.
    const refused = bundle.cronCases.cases.filter((entry) =>
      ["x * * * *", "*/0 * * * *", "* * * *"].includes(entry.expr)
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((entry) => entry.matches === false)).toBe(true);

    expect(bundle.cronWindows.cases).toHaveLength(8);
    expect(bundle.cronWindows.maxBackfillOccurrences).toBe(24);

    const kinds = new Set(
      bundle.manifests.flatMap(
        (entry) => (entry as { kinds?: string[] }).kinds ?? []
      )
    );
    expect([...kinds].sort()).toStrictEqual([
      "condition",
      "cron",
      "data",
      "event",
      "webhook",
    ]);
    // Four of the refusals are the watch guard and the provider catalogue.
    const refusedManifests = bundle.manifests.filter(
      (entry) => (entry as { outcome: string }).outcome === "refused"
    );
    expect(refusedManifests.length).toBeGreaterThanOrEqual(16);

    // 3 tiers + the unreadable case, x 2 lanes, x 2 provenance answers.
    expect(bundle.gate.grid).toHaveLength(16);
    expect(bundle.gate.tiers).toStrictEqual(["off", "device", "gateway"]);
    expect(bundle.gate.lanes).toStrictEqual(["device", "gateway"]);

    const recipes = bundle.recipes as {
      reserved: string[];
      weights: { capability: string }[];
    };
    expect(recipes.reserved).toHaveLength(7);
    expect(recipes.weights.map((entry) => entry.capability)).toContain("faces");
  });

  // THE FINDING, held as a test rather than a paragraph: with no zone at all,
  // v0 answers the host clock — and on a UTC host that is the wrong answer for
  // every member outside UTC.
  it("records v0's host-clock tier as a finding, not a fix", async () => {
    const bundle = await buildAutomationsParity();
    const finding = bundle.cronCases.finding as {
      withVaultZone: boolean;
      withNoZone: boolean;
      vaultZone: string;
    };
    expect(finding.vaultZone).toBe("Asia/Kolkata");
    expect(finding.withVaultZone).toBe(true);
    expect(finding.withNoZone).toBe(false);
  });
});
