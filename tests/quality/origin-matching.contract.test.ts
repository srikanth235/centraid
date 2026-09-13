// THE PROMOTED ORIGIN-MATCHING SPEC, RUN THROUGH BOTH V0 IMPLEMENTATIONS
// (#1020, wave 4 lane Locker, D-1020-L8).
//
// `apps/extension/spec/origin-matching-v1.json` was a committed, language-
// neutral spec fixture already in the shape `contracts/` wants, with two
// implementations of one policy between them: the Companion's
// (`apps/extension/src/origin-matching.ts`) and the app's
// (`packages/blueprints/apps/locker/queries/origin-matching.ts`). Wave 4 adds a
// third in Rust (`crates/apps/locker::origin`) and promotes the spec to
// `contracts/origin-matching-v1.json`, byte-identical.
//
// THREE IMPLEMENTATIONS, ONE FILE, OR SOMETHING IS RED. This test runs the
// PROMOTED file — not the extension's copy — through v0's two, so the promotion
// is load-bearing rather than decorative: a spec nobody reads from its new home
// is a spec that drifts from it. `crates/apps/locker/src/origin.rs`'s
// `every_vector_of_the_promoted_spec_passes` is the third reader, and
// `the_promoted_spec_is_byte_identical_to_the_extensions` asserts the two
// copies are one file's worth of bytes.
//
// This is a fixture adapter under `tests/**` — the one permitted kind of edit
// to the pinned v0 tree. It adds no product code and changes no v0 behaviour.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { matchesOrigin as appMatches } from "../../packages/blueprints/apps/locker/queries/origin-matching.js";

const ROOT = path.join(import.meta.dirname, "..", "..");

interface Vector {
  name: string;
  stored: string;
  page: string;
  policy: "registrable-domain" | "exact-host";
  match: boolean;
}

function spec(relative: string): { version: number; vectors: Vector[] } {
  return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8")) as {
    version: number;
    vectors: Vector[];
  };
}

describe("contracts/origin-matching-v1.json", () => {
  it("is byte-identical to the extension's spec", () => {
    // The promotion is a MOVE, not an edit. While the v0 tree exists both
    // copies are present and neither may drift from the other.
    expect(
      readFileSync(path.join(ROOT, "contracts/origin-matching-v1.json"))
    ).toStrictEqual(
      readFileSync(
        path.join(ROOT, "apps/extension/spec/origin-matching-v1.json")
      )
    );
  });

  it("passes through the Locker app's implementation", () => {
    const { version, vectors } = spec("contracts/origin-matching-v1.json");
    expect(version).toBe(1);
    expect(vectors).toHaveLength(24);
    const failures: string[] = [];
    for (const vector of vectors) {
      const actual = appMatches(
        { url: vector.stored, url_match_policy: vector.policy },
        vector.page
      );
      if (actual !== vector.match) {
        failures.push(
          `${vector.name}: ${vector.stored} × ${vector.page} under ${vector.policy} — expected ${vector.match}, got ${actual}`
        );
      }
    }
    expect(failures, failures.join("\n")).toHaveLength(0);
  });

  it("passes through the Companion's implementation", async () => {
    // COMPUTED, NOT LITERAL: `apps/extension` has its own tsconfig and a
    // literal import would pull the extension's `chrome.d.ts` ambient types
    // into this program. `origin-matching.ts` is import-free apart from
    // `tldts`, which is exactly why it is the file both sides can read.
    const moduleUrl = pathToFileURL(
      path.resolve("apps/extension/src/origin-matching.ts")
    ).href;
    const companion = (await import(moduleUrl)) as {
      matchesOrigin: (
        candidate: { url: string; url_match_policy?: string },
        pageUrl: string
      ) => boolean;
    };
    const { vectors } = spec("contracts/origin-matching-v1.json");
    const failures: string[] = [];
    for (const vector of vectors) {
      const actual = companion.matchesOrigin(
        { url: vector.stored, url_match_policy: vector.policy },
        vector.page
      );
      if (actual !== vector.match) {
        failures.push(
          `${vector.name}: expected ${vector.match}, got ${actual}`
        );
      }
    }
    expect(failures, failures.join("\n")).toHaveLength(0);
  });
});
