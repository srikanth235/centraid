// THE LOCKER PARITY FIXTURE'S EMITTER AND ITS ORACLE, in one file (#1020, wave
// 4 lane Locker, D-1020-D3-6).
//
// This is the one permitted kind of edit to the pinned v0 tree: a fixture
// adapter under `packages/*/test/**` or `tests/**` that makes a v0 suite read
// `contracts/` files (#1020, Execution plan → Invariants). It adds no product
// code and changes no v0 behaviour.
//
// It lives under `tests/` for the reason Tally's and Photos' adapters record:
// `packages/vault/tsconfig.test.json` sets `rootDir: "."`, so a file there
// cannot import both `contracts/tools/` and the blueprint handlers it invokes,
// and `tests/`'s own tsconfig already spans the repository. Nothing was
// relaxed to get here.
//
// TWO JOBS, ONE COMMAND. With `CENTRAID_WRITE_CONTRACTS=1` it WRITES the three
// files under `contracts/apps/locker/`; without it, it rebuilds the bundle from
// the live v0 tree and asserts equality with what is committed. So "the fixture
// passes in v0 too" is not a second suite that could rot — it is this test, and
// it fails the moment a v0 handler's answer moves.
//
// ONE THING THIS ADAPTER ASSERTS THAT THE OTHERS DO NOT: that the bundle it
// produced carries **no plaintext secret**. The corpus writes real passwords,
// card numbers and OTP seeds through the real commands, and the canonicaliser
// is what keeps them out of the file. A fixture that leaked one would be a
// secret committed to a repository, so the check is here rather than only in
// the tool that could be edited.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LOCKER_PARITY_DIR,
  buildLockerParity,
  stableJson,
} from "../../contracts/tools/export-locker-parity.js";

/** The repository root, from this file's own location. */
const ROOT = path.join(import.meta.dirname, "..", "..");

const WRITE = process.env.CENTRAID_WRITE_CONTRACTS === "1";

const FILES = ["rows.json", "queries.json", "commands.json"] as const;

/**
 * The plaintexts the corpus writes. If any of these reaches a fixture file the
 * generator has leaked a secret into the repository, and no amount of "it is
 * only a test password" makes a committed credential a good idea.
 */
const PLANTED = [
  "correct-horse-battery-staple",
  "a-rotated-password-42",
  "a-different-passphrase",
  "4242 4242 4242 4242",
  "JBSWY3DPEHPK3PXP",
  "the safe combination",
  "0000-1111-2222",
  "BEGIN PRIVATE KEY",
];

describe("contracts/apps/locker", () => {
  it("is what the v0 handlers answer", async () => {
    const bundle = await buildLockerParity();
    const payloads: Record<(typeof FILES)[number], string> = {
      "rows.json": stableJson(bundle.rows),
      "queries.json": stableJson(bundle.queries),
      "commands.json": stableJson(bundle.commands),
    };

    // NO SECRET REACHES A FILE. Checked before anything is written, so a write
    // run cannot commit one and then notice.
    for (const [file, payload] of Object.entries(payloads)) {
      for (const secret of PLANTED) {
        expect(
          payload,
          `${file} carries the plaintext of a corpus secret — the canonicaliser missed it`
        ).not.toContain(secret);
      }
    }

    // THE ASSERTION IS NOT VACUOUS, and the two halves say different things.
    //
    // `rows.json` and `commands.json` MUST carry a token: the corpus wrote
    // secrets, they are sealed at rest, and a bundle with no token would mean
    // the canonicaliser never saw one.
    for (const file of ["rows.json", "commands.json"] as const) {
      expect(payloads[file], `${file} carries no sealed cell at all`).toContain(
        "«"
      );
    }
    // `queries.json` MUST NOT carry one — not even a token. Every Locker query
    // payload is secret-free by construction (`ITEM_COLUMNS` is the browsable
    // half, a sidecar returns the SHAPE of a secret), so a sealed cell
    // reaching a query answer is a port-independent finding about v0 and this
    // is where it would surface.
    expect(
      payloads["queries.json"].includes("lk1:") ||
        payloads["queries.json"].includes("sealed:v1:"),
      "a Locker query answer carries ciphertext — no query payload may"
    ).toBe(false);

    for (const file of FILES) {
      const target = path.join(ROOT, LOCKER_PARITY_DIR, file);
      if (WRITE) {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, payloads[file]);
      }
      if (!existsSync(target)) {
        // THE BUNDLE IS PENDING, and this is the honest failure rather than a
        // skip that reads green. The message is the command.
        throw new Error(
          `${file} is not committed yet. Run it with CENTRAID_WRITE_CONTRACTS=1 to emit the bundle, then \`bun run format && git diff --exit-code contracts/apps/locker\`, then drop \`fixtures: "pending-regeneration"\` from contracts/apps/locker/manifest.json and replace crates/apps/locker/tests/parity.rs's declaration test with the comparison.`
        );
      }
      // Read BACK, in both modes. A write run that asserts nothing is a run
      // that can emit an empty fixture and call it a pass.
      const committed = readFileSync(target, "utf8");
      // Parsed, not compared as text: the repository formatter owns JSON, so
      // the committed bytes are this emitter's output AFTER oxfmt. The VALUES
      // are what parity means.
      expect(
        JSON.parse(committed),
        `${file} is stale — regenerate it`
      ).toStrictEqual(JSON.parse(payloads[file]));
    }
  });

  it("answers the same thing twice, so regeneration is idempotent", async () => {
    const first = await buildLockerParity();
    const second = await buildLockerParity();
    // THE POINT OF THE CANONICALISER. Two runs seal the same secrets under
    // different nonces and mint different key ids; if the bundles differ, the
    // fixture would fail `git diff --exit-code` on every regeneration and
    // nobody would ever regenerate it.
    expect(stableJson(second.rows)).toBe(stableJson(first.rows));
    expect(stableJson(second.queries)).toBe(stableJson(first.queries));
    expect(stableJson(second.commands)).toBe(stableJson(first.commands));
  });
});
