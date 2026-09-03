import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");

export function readRepoFile(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

export function checkHygieneGates() {
  const errors = [];

  let ci;
  let imageLane;
  let gitleaksToml;
  let trivyIgnore;
  let osvToml;

  try {
    ci = readRepoFile(".github/workflows/ci.yml");
  } catch {
    errors.push("missing .github/workflows/ci.yml");
    return { ok: false, errors };
  }
  try {
    imageLane = readRepoFile(
      ".github/workflows/lane-release-gateway-image.yml"
    );
  } catch {
    errors.push("missing .github/workflows/lane-release-gateway-image.yml");
    return { ok: false, errors };
  }
  try {
    gitleaksToml = readRepoFile(".gitleaks.toml");
  } catch {
    errors.push("missing .gitleaks.toml");
  }
  try {
    trivyIgnore = readRepoFile(".trivyignore");
  } catch {
    errors.push("missing .trivyignore");
  }
  try {
    osvToml = readRepoFile("osv-scanner.toml");
  } catch {
    errors.push("missing osv-scanner.toml");
  }

  if (!/^\s*gitleaks:\s*$/mu.test(ci)) {
    errors.push("ci.yml must define a top-level job named gitleaks");
  }
  if (!/gitleaks detect/u.test(ci)) {
    errors.push("ci.yml gitleaks job must invoke `gitleaks detect`");
  }
  if (!/\.gitleaks\.toml/u.test(ci)) {
    errors.push("ci.yml gitleaks job must pass --config .gitleaks.toml");
  }
  const checkJob = ci.slice(ci.indexOf("\n  check:"));
  if (!/\bgitleaks\b/u.test(checkJob)) {
    errors.push("ci.yml `check` needs: list must include gitleaks");
  }
  if (gitleaksToml !== undefined && !/allowlist/iu.test(gitleaksToml)) {
    errors.push(".gitleaks.toml must define an allowlist section");
  }

  if (!/^\s*osv-scanner:\s*$/mu.test(ci)) {
    errors.push("ci.yml must define a top-level job named osv-scanner");
  }
  if (!/osv-scanner_linux_amd64|google\/osv-scanner-action/u.test(ci)) {
    errors.push("ci.yml must install or invoke OSV-Scanner");
  }
  if (!/osv-lockfile-scan\.mjs/u.test(ci)) {
    errors.push("ci.yml must run scripts/ci/osv-lockfile-scan.mjs");
  }
  if (!/\bosv-scanner\b/u.test(checkJob)) {
    errors.push("ci.yml `check` needs: list must include osv-scanner");
  }
  if (osvToml !== undefined && osvToml.trim().length === 0) {
    errors.push("osv-scanner.toml must not be empty");
  }

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
