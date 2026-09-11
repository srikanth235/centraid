#!/usr/bin/env node
// The stamped entry point to the governance directives (#988).
//
// `.governance/run.sh` is a digest-locked managed file (`.governance/install.yaml`
// `managed_digests`), so the stamp cannot live inside it — the same constraint
// that put the #915 rung-0 deferral in `.githooks/pre-commit`. It lives here
// instead: `bun run governance` is the entry point a developer, a hook or an
// agent calls, and it delegates the whole run to the managed script unchanged.
//
// A directive filter (`bun run governance repo-hygiene`) never touches the
// stamp: a stamp asserts that EVERY directive passed against a tree, and one
// directive's verdict cannot be promoted into that claim.
import { spawnSync } from "node:child_process";

import { isFresh, record, repoRoot, stampKey } from "./gate-stamp.mjs";

const TIER = "governance";
const args = process.argv.slice(2);
const root = repoRoot();
const filtered = args.length > 0;
const key = filtered ? null : stampKey(root);

if (key !== null && isFresh(TIER, key)) {
  process.stderr.write(
    `⊘ governance stamped for tree ${key.tree.slice(0, 9)} ` +
      `(base ${key.base.slice(0, 9)}) — re-run with CENTRAID_GATE_STAMPS=0\n`
  );
  process.exit(0);
}

const run = spawnSync("bash", [".governance/run.sh", ...args], {
  cwd: root,
  stdio: "inherit",
});
const code = run.status ?? 1;
if (code === 0 && key !== null) record(TIER, key);
process.exit(code);
