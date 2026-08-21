import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "vitest";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { buildEpochPair, VAULT_LADDER_LENGTH } from "../../scripts/corpora/vault-corpus.js";

describe("det", () => {
  test("diff", async () => {
    const a = await tempDir("det-a-");
    const b = await tempDir("det-b-");
    buildEpochPair(a, VAULT_LADDER_LENGTH);
    buildEpochPair(b, VAULT_LADDER_LENGTH);
    for (const name of ["vault.db", "journal.db"]) {
      const ba = await readFile(path.join(a, name));
      const bb = await readFile(path.join(b, name));
      let first = -1, diffs = 0;
      const n = Math.max(ba.length, bb.length);
      for (let i = 0; i < n; i++) { if (ba[i] !== bb[i]) { if (first < 0) first = i; diffs++; } }
      console.log(`${name}: lenA=${ba.length} lenB=${bb.length} firstDiff=${first} totalDiffs=${diffs}`);
      if (first >= 0) {
        const s = Math.max(0, first - 4), e = first + 12;
        console.log(`  A[${s}..${e}]=`, [...ba.subarray(s, e)].map(x=>x.toString(16).padStart(2,'0')).join(' '));
        console.log(`  B[${s}..${e}]=`, [...bb.subarray(s, e)].map(x=>x.toString(16).padStart(2,'0')).join(' '));
      }
    }
  });
});
