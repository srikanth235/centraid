import assert from "node:assert/strict";
import test from "node:test";

import { checkHygieneGates, readRepoFile } from "./hygiene-gates.mjs";

test("shipped hygiene gates pass the structural contract", () => {
  const { ok, errors } = checkHygieneGates();
  assert.equal(ok, true, errors.join("\n"));
});

test("ci.yml rolls gitleaks and osv-scanner into the required check job", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");
  const checkBlock = ci.slice(ci.indexOf("\n  check:"));
  assert.match(checkBlock, /\bgitleaks\b/u);
  assert.match(checkBlock, /\bosv-scanner\b/u);
  assert.match(checkBlock, /\bdependency-review\b/u);
});

test("gitleaks config allowlists fixtures without disabling all rules", () => {
  const cfg = readRepoFile(".gitleaks.toml");
  assert.match(cfg, /useDefault\s*=\s*true/u);
  assert.match(cfg, /allowlist/u);
  assert.match(cfg, /packages\/data-plane\/fixtures/u);
});

test("gateway image lane fails closed on critical/high image vulns", () => {
  const lane = readRepoFile(".github/workflows/lane-release-gateway-image.yml");
  assert.match(lane, /aquasecurity\/trivy-action@[0-9a-f]{40}/u);
  assert.match(lane, /severity:\s*CRITICAL,HIGH/u);
  assert.match(lane, /exit-code:\s*["']1["']/u);
});
