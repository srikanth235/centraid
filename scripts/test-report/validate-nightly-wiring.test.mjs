import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const e2ePath = path.join(root, ".github/workflows/e2e.yml");

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

  test("the rolling-issue job sees every lane, mutation-testing included (A2)", () => {
    const failBlock = e2e.slice(e2e.indexOf("nightly-lane-issues:"));
    expect(failBlock).toMatch(/mutation-testing/u);
    expect(failBlock).toMatch(/toJSON\(needs\)/u);
  });

  test("a failed issue create is loud, never swallowed (A11)", () => {
    const failBlock = e2e.slice(e2e.indexOf("nightly-lane-issues:"));
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
