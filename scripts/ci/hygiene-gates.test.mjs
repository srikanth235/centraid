import assert from "node:assert/strict";
import test from "node:test";

import { checkHygieneGates, readRepoFile } from "./hygiene-gates.mjs";

test("shipped hygiene gates pass the structural contract", () => {
  const { ok, errors } = checkHygieneGates();
  assert.equal(ok, true, errors.join("\n"));
});

test("the pull-request gate carries gitleaks and osv-scanner as steps", () => {
  const steps = readRepoFile("crates/xtask/src/gate.rs");
  assert.match(steps, /step\("secrets",\s*run_secrets\)/u);
  assert.match(steps, /step\("osv",\s*run_osv\)/u);
  const workflow = readRepoFile(".github/workflows/gate.yml");
  assert.match(workflow, /cargo xtask gate --profile pr/u);
});

test("gitleaks config allowlists fixtures without disabling all rules", () => {
  const cfg = readRepoFile(".gitleaks.toml");
  assert.match(cfg, /useDefault\s*=\s*true/u);
  assert.match(cfg, /allowlist/u);
});

test("gateway image lane fails closed on critical/high image vulns", () => {
  const lane = readRepoFile(".github/workflows/lane-release-gateway-image.yml");
  assert.match(lane, /aquasecurity\/trivy-action@[0-9a-f]{40}/u);
  assert.match(lane, /severity:\s*CRITICAL,HIGH/u);
  assert.match(lane, /exit-code:\s*["']1["']/u);
});
