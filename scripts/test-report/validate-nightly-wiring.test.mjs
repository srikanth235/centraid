import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const e2ePath = path.join(root, ".github/workflows/e2e.yml");

/**
 * Structural unit tests for nightly wiring (#545 A9). Complements the
 * executable validate-nightly-wiring.mjs gate by asserting the #545 A1/A2
 * quality-outcome aggregator and mutation gating stay present.
 */
describe("validate-nightly-wiring structure (#545)", () => {
  const e2e = readFileSync(e2ePath, "utf8");

  test("mutation-testing job does not use continue-on-error on Stryker", () => {
    const mutationBlock = e2e.slice(
      e2e.indexOf("mutation-testing:"),
      e2e.indexOf("test-health-report:")
    );
    expect(mutationBlock).toMatch(/bun run test:mutation/u);
    expect(mutationBlock).not.toMatch(
      /continue-on-error:\s*true\s*\n\s*# Upload/u
    );
    // The Stryker step itself must not be continue-on-error.
    const strykerStep = mutationBlock.match(
      /name: Run Stryker[\s\S]*?(?=\n\s+- (?:name:|uses:)|$)/u
    );
    expect(strykerStep?.[0] ?? "").not.toMatch(/continue-on-error:\s*true/u);
  });

  test("test-health-report re-reads coverage/perf/scale outcomes into failure (A1)", () => {
    expect(e2e).toMatch(/Fail if quality lanes failed/u);
    expect(e2e).toMatch(/steps\.coverage\.outcome/u);
    expect(e2e).toMatch(/steps\.perf\.outcome/u);
    expect(e2e).toMatch(/steps\.scale\.outcome/u);
  });

  test("nightly-failure-issue needs mutation-testing (A2)", () => {
    const failBlock = e2e.slice(e2e.indexOf("nightly-failure-issue:"));
    expect(failBlock).toMatch(/mutation-testing/u);
    expect(failBlock).toMatch(/needs\.mutation-testing\.result/u);
  });

  test("pairing flows run under one suite job", () => {
    const pairingJobs = [
      ...e2e.matchAll(/^\s{2}(?<job>pairing-[^:]+):/gmu),
    ].map(({ groups }) => groups.job);
    expect(pairingJobs).toEqual(["pairing-e2e"]);

    const pairingBlock = e2e.slice(
      e2e.indexOf("  pairing-e2e:"),
      e2e.indexOf("  mutation-testing:")
    );
    for (const flow of [
      "device-pairing-lifecycle.mjs",
      "pairing-ticket-hygiene.mjs",
      "cross-network-relay.mjs",
    ]) {
      expect(pairingBlock).toContain(flow);
    }
    expect(pairingBlock).toMatch(/Run pairing flows concurrently/u);
    for (const pid of [
      "lifecycle_pid=$!",
      "ticket_hygiene_pid=$!",
      "cross_network_relay_pid=$!",
    ]) {
      expect(pairingBlock).toContain(pid);
    }
    expect(pairingBlock).toMatch(/Fail if pairing suite failed/u);
    expect(pairingBlock).toMatch(/nightly-evidence-pairing/u);
  });

  test("iOS suites fan out from one native build artifact", () => {
    const iosBlock = e2e.slice(
      e2e.indexOf("  mobile-e2e-ios-build:"),
      e2e.indexOf("  mobile-e2e-android:")
    );
    expect(iosBlock).toMatch(/mobile-e2e-ios:/u);
    expect(iosBlock).toMatch(/needs:\s+mobile-e2e-ios-build/u);
    expect(iosBlock).toMatch(/fail-fast:\s+false/u);
    expect(iosBlock).toMatch(/nightly-mobile-ios-app/u);
    expect(iosBlock).toMatch(
      /nightly-evidence-mobile-ios-\$\{\{ matrix\.suite \}\}/u
    );
    for (const suite of [
      "home-loads",
      "template-gate",
      "native-v0-resilience",
      "volume-proof",
      "cold-start",
      "scroll-frames",
    ]) {
      expect(iosBlock).toContain(`- ${suite}`);
    }
  });

  test("a failed issue create is loud, never swallowed (A11)", () => {
    // #557 moved the open-or-update logic out of four near-identical inline
    // shell blocks into scripts/ci/file-tracking-issue.mjs. The A11 invariant
    // is unchanged — a failed create must not be swallowed — so this asserts it
    // in both halves: the workflow delegates rather than hand-rolling `gh`, and
    // the script it delegates to exits non-zero. (The decision tree itself is
    // covered by scripts/ci/file-tracking-issue.test.mjs.)
    const failBlock = e2e.slice(e2e.indexOf("nightly-failure-issue:"));
    expect(failBlock).toMatch(/scripts\/ci\/file-tracking-issue\.mjs/u);
    expect(failBlock).not.toMatch(/gh issue create/u);
    expect(failBlock).not.toMatch(/gh issue create[^\n]*\|\|\s*true/u);

    const filer = readFileSync(
      path.join(root, "scripts/ci/file-tracking-issue.mjs"),
      "utf8"
    );
    expect(filer).toMatch(
      /::error::Failed to \$\{result\.action\} tracking issue/u
    );
    expect(filer).toMatch(/process\.exitCode = 1/u);
  });

  test("every workflow that files a tracking issue uses the shared filer", () => {
    // The four copies had already drifted before they were merged — one lost
    // its `--label` fallback, another swallowed every failure with
    // `|| echo "::warning::"`. Nothing is left to drift back apart.
    for (const workflow of [
      "e2e.yml",
      "extension-e2e.yml",
      "interop-weekly.yml",
    ]) {
      const source = readFileSync(
        path.join(root, ".github/workflows", workflow),
        "utf8"
      );
      expect(
        source,
        `${workflow} must not hand-roll gh issue create`
      ).not.toMatch(/gh issue create/u);
      expect(
        source,
        `${workflow} must not hand-roll gh issue comment`
      ).not.toMatch(/gh issue comment/u);
    }
  });
});
