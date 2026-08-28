// The mounted-scope cap is ONE number in TWO packages (#880).
//
// The phone attaches at most N replica files into one op-sqlite connection
// (`MultiVaultReplicaReader`), and it opens exactly one multiplex SSE carrying
// those same N mounts. The gateway route refuses a subscription with more than
// its own N. Before this test the two numbers were unlinked literals — 4 in
// `apps/mobile/src/lib/replica/offline-budgets.ts`, 4 in
// `packages/server/src/routes/multiplex-replica-routes.ts` — with nothing
// holding them together. Raising only the phone's would have mounted a fifth
// replica the gateway then refuses to feed, and the symptom is not "your
// request was rejected": it is a vault on the phone that quietly never syncs
// again.
//
// The fix was to give the number one home on the wire contract both sides
// already import (`@centraid/core/protocol`). What this test pins is that the
// home stays single: a value re-agreement is easy to write and easy to lose,
// so the assertions are structural — neither call site may declare a cap of
// its own again.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { MAX_MULTIPLEX_REPLICA_SCOPES } from "@centraid/core/protocol";

import { MAX_MOUNTED_NATIVE_SCOPES } from "../../apps/mobile/src/lib/replica/offline-budgets.js";

const root = path.resolve(import.meta.dirname, "../..");

const NATIVE_BUDGETS = "apps/mobile/src/lib/replica/offline-budgets.ts";
const MULTIPLEX_ROUTE =
  "packages/server/src/routes/multiplex-replica-routes.ts";

async function source(file: string): Promise<string> {
  return readFile(path.join(root, file), "utf8");
}

describe("issue #880 replica mounted-scope cap", () => {
  test("the native mount cap and the multiplex route cap are the same constant", () => {
    expect(MAX_MULTIPLEX_REPLICA_SCOPES).toBe(MAX_MOUNTED_NATIVE_SCOPES);
    expect(Number.isSafeInteger(MAX_MULTIPLEX_REPLICA_SCOPES)).toBe(true);
    expect(MAX_MULTIPLEX_REPLICA_SCOPES).toBeGreaterThan(0);
  });

  test("neither call site re-declares a cap of its own", async () => {
    const sources = await Promise.all(
      [NATIVE_BUDGETS, MULTIPLEX_ROUTE].map(async (file) => ({
        file,
        text: await source(file),
      }))
    );
    for (const { file, text } of sources) {
      expect(text, `${file} no longer imports the shared cap`).toContain(
        "MAX_MULTIPLEX_REPLICA_SCOPES"
      );
      expect(text, `${file} does not import it from the protocol`).toMatch(
        /from "@centraid\/core\/protocol"/u
      );
      // A local `const MAX_… = <number>` is the exact regression this file
      // exists to stop: it compiles, it passes every other gate, and it puts
      // the two sides back out of contact.
      expect(
        /(?:MAX_[A-Z_]*SCOPES)\s*(?::[^=]+)?=\s*\d/u.test(text),
        `${file} declares a numeric scope cap instead of importing one`
      ).toBe(false);
    }
  });

  test("the route's refusal message is derived from the shared cap", async () => {
    const text = await source(MULTIPLEX_ROUTE);
    // Matched as a pattern rather than a literal so the assertion itself
    // cannot contain an uninterpolated `${…}` placeholder.
    expect(text).toMatch(
      /mounts must contain 1\.\.\$\{MAX_MULTIPLEX_REPLICA_SCOPES\} scopes/u
    );
  });
});
