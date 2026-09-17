/**
 * Structural contract for the three high-signal hygiene gates (#671).
 *
 * Asserts the shipped workflow YAML, xtask and config files still wire:
 *   1. gitleaks (secrets) as the `secrets` step of `cargo xtask gate --profile
 *      pr`, with the binary installed by gate.yml
 *   2. osv-scanner (lockfile SCA) as the `osv` step, running
 *      scripts/ci/osv-lockfile-scan.mjs, with the binary installed by gate.yml
 *   3. trivy (image) on the gateway image release lane after build
 *
 * `ci.yml` held (1) and (2) as jobs until #1020 moved the pull-request gate to
 * `cargo xtask gate` (D-1020-G3); the contract follows them there.
 *
 * Offline, no network — companions lint-workflow-pins rather than replacing it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Read a UTF-8 file relative to the monorepo root.
 * @param {string} rel Path from repo root.
 * @returns {string} File contents.
 */
export function readRepoFile(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

/**
 * Validate that the three hygiene gates remain wired in shipped configs.
 * @returns {{ ok: boolean, errors: string[] }} Whether the contract holds and any violations.
 */
export function checkHygieneGates() {
  const errors = [];

  /**
   * Read a required file, recording a violation when it is missing.
   * @param {string} rel Path from repo root.
   * @returns {string | undefined} Contents, or undefined when missing.
   */
  const required = (rel) => {
    try {
      return readRepoFile(rel);
    } catch {
      errors.push(`missing ${rel}`);
      return undefined;
    }
  };

  const gateWorkflow = required(".github/workflows/gate.yml");
  const gateSteps = required("crates/xtask/src/gate.rs");
  const imageLane = required(
    ".github/workflows/lane-release-gateway-image.yml"
  );
  const gitleaksToml = required(".gitleaks.toml");
  const trivyIgnore = required(".trivyignore");
  const osvToml = required("osv-scanner.toml");

  if (gateWorkflow !== undefined) {
    if (!/cargo xtask gate --profile pr/u.test(gateWorkflow)) {
      errors.push("gate.yml must run `cargo xtask gate --profile pr`");
    }
    if (!/gitleaks\/gitleaks\/releases\/download/u.test(gateWorkflow)) {
      errors.push("gate.yml must install the pinned gitleaks release");
    }
    if (!/google\/osv-scanner\/releases\/download/u.test(gateWorkflow)) {
      errors.push("gate.yml must install the pinned osv-scanner release");
    }
  }

  if (gateSteps !== undefined) {
    if (!/step\("secrets",\s*run_secrets\)/u.test(gateSteps)) {
      errors.push(
        "cargo xtask gate must declare the `secrets` (gitleaks) step"
      );
    }
    if (!/Command::new\("gitleaks"\)/u.test(gateSteps)) {
      errors.push("the `secrets` step must invoke gitleaks");
    }
    if (!/\.gitleaks\.toml/u.test(gateSteps)) {
      errors.push("the `secrets` step must pass --config .gitleaks.toml");
    }
    if (!/step\("osv",\s*run_osv\)/u.test(gateSteps)) {
      errors.push("cargo xtask gate must declare the `osv` step");
    }
    if (!/scripts\/ci\/osv-lockfile-scan\.mjs/u.test(gateSteps)) {
      errors.push("the `osv` step must run scripts/ci/osv-lockfile-scan.mjs");
    }
  }
  if (gitleaksToml !== undefined && !/allowlist/iu.test(gitleaksToml)) {
    errors.push(".gitleaks.toml must define an allowlist section");
  }
  if (osvToml !== undefined && osvToml.trim().length === 0) {
    errors.push("osv-scanner.toml must not be empty");
  }

  if (imageLane !== undefined) {
    if (!/aquasecurity\/trivy-action@/u.test(imageLane)) {
      errors.push(
        "lane-release-gateway-image.yml must use aquasecurity/trivy-action (SHA-pinned)"
      );
    }
    if (!/aquasecurity\/trivy-action@[0-9a-f]{40}/u.test(imageLane)) {
      errors.push("trivy-action must be pinned to a 40-char commit SHA");
    }
    if (!/severity:\s*CRITICAL,HIGH/u.test(imageLane)) {
      errors.push("Trivy must fail on CRITICAL,HIGH severity");
    }
    if (!/exit-code:\s*["']?1["']?/u.test(imageLane)) {
      errors.push("Trivy must set exit-code: 1 (fail closed)");
    }
    if (!/\.trivyignore/u.test(imageLane)) {
      errors.push("Trivy must honor .trivyignore");
    }
    const buildIdx = imageLane.search(/Build and push|build-push-action/u);
    const trivyIdx = imageLane.search(/trivy-action|Trivy image scan/u);
    if (buildIdx < 0 || trivyIdx < 0 || trivyIdx < buildIdx) {
      errors.push(
        "Trivy step must appear after the gateway image build/push step"
      );
    }
  }
  if (trivyIgnore !== undefined && !/#671/u.test(trivyIgnore)) {
    errors.push(".trivyignore should reference issue #671 for audit trail");
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const { ok, errors } = checkHygieneGates();
  if (!ok) {
    for (const e of errors) console.error(`hygiene-gates: ${e}`);
    process.exit(1);
  }
  console.log("hygiene-gates: ok (gitleaks + osv-scanner + trivy wired)");
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main();
}
