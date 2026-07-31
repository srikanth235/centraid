/**
 * Structural gate for the release lane (#656 Layer 1F).
 *
 * `release.yml` plus five `lane-release-*.yml` files are ~880 lines of YAML with
 * zero structural validation, and `lint:actions` (actionlint) is not part of
 * `check:pr`. Their load-bearing invariants are documented only in comments, so
 * the failure mode is silent: a lane added without adding it to
 * `release-check.needs` still shows a green "release-check" while that surface
 * is broken — exactly the four-separate-reds problem #557 set out to end.
 *
 * This asserts the shipped wiring the way `validate-nightly-wiring.mjs` does —
 * over the real YAML text, not a reimplementation of it, and without a YAML
 * parser dependency the repo does not declare.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** Strip YAML comments so prose cannot satisfy or trip a structural check. */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => {
      // Only strip a `#` that starts a comment, not one inside a quoted string.
      // Release YAML has no `#` inside quotes today; a conservative rule that
      // keeps quoted hashes is cheaper than a parser.
      let quote = null;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === "#") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Split the `jobs:` mapping into `{ id → body }`. Job ids are the two-space
 * keys under `jobs:`; a body runs to the next such key.
 */
function jobBlocks(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  const blocks = new Map();
  if (start === -1) return blocks;
  let current = null;
  let body = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}(?<id>[A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (header?.groups) {
      if (current) blocks.set(current, body.join("\n"));
      current = header.groups.id;
      body = [];
      continue;
    }
    if (/^\S/u.test(line) && line.trim() !== "") break; // left the jobs mapping
    body.push(line);
  }
  if (current) blocks.set(current, body.join("\n"));
  return blocks;
}

/** Names listed under a lane's `on.workflow_call.secrets:` mapping. */
function declaredLaneSecrets(text) {
  const secretsIdx = text.indexOf("\n    secrets:");
  if (secretsIdx === -1) return new Set();
  const rest = text
    .slice(secretsIdx + 1)
    .split("\n")
    .slice(1);
  const names = new Set();
  for (const line of rest) {
    if (line.trim() === "") continue;
    const entry = /^ {6}(?<name>[A-Za-z0-9_]+):\s*$/u.exec(line);
    if (entry?.groups) {
      names.add(entry.groups.name);
      continue;
    }
    if (/^ {8}\S/u.test(line)) continue; // `required: false` under a name
    break;
  }
  return names;
}

/** Secret names a `uses:` job forwards in its own `secrets:` block. */
function forwardedSecrets(jobBody) {
  const idx = jobBody.indexOf("\n    secrets:");
  if (idx === -1) return new Set();
  const names = new Set();
  for (const line of jobBody
    .slice(idx + 1)
    .split("\n")
    .slice(1)) {
    if (line.trim() === "") continue;
    const entry = /^ {6}(?<name>[A-Za-z0-9_]+):/u.exec(line);
    if (!entry?.groups) break;
    names.add(entry.groups.name);
  }
  return names;
}

/**
 * Assert the release lane's structural contract.
 * @param {string} [root] Repository root to inspect.
 * @returns {string[]} Human-readable violations; empty means the lane is sound.
 */
export function lintReleaseWiring(root = REPO_ROOT) {
  const errors = [];
  const workflowDir = path.join(root, ".github/workflows");
  const files = readdirSync(workflowDir).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml")
  );

  const releasePath = path.join(workflowDir, "release.yml");
  if (!files.includes("release.yml")) {
    errors.push("missing .github/workflows/release.yml");
    return errors;
  }
  const release = stripComments(readFileSync(releasePath, "utf8"));

  // (1) One entry point. Only release.yml may listen on pushed tags — otherwise
  // one tag fans out into unrelated runs with no shared red/green again.
  for (const name of files) {
    if (name === "release.yml") continue;
    const text = stripComments(
      readFileSync(path.join(workflowDir, name), "utf8")
    );
    if (/^\s{2,}tags:\s*$/mu.test(text) && /^on:/mu.test(text)) {
      const onBlock = text.slice(text.indexOf("\non:"));
      const jobsAt = onBlock.indexOf("\njobs:");
      if (
        (jobsAt === -1 ? onBlock : onBlock.slice(0, jobsAt)).includes("tags:")
      )
        errors.push(
          `${name} listens on pushed tags — release.yml is the single tag entry point (#557)`
        );
    }
  }
  if (!/^ {2,}tags:\s*$/mu.test(release))
    errors.push("release.yml no longer listens on `push: tags`");

  // (2) A tag is immutable: never cancel a release mid-flight.
  if (!/cancel-in-progress:\s*false/u.test(release))
    errors.push(
      "release.yml concurrency must set cancel-in-progress: false — a tag is immutable"
    );

  // (3) Least privilege at the workflow level; lanes widen per job.
  const headPermissions = release.slice(0, release.indexOf("\njobs:"));
  if (!/^permissions:\s*\n\s+contents:\s*read\s*$/mu.test(headPermissions))
    errors.push(
      "release.yml must default to workflow-level `permissions: contents: read`"
    );

  // (4) `secrets: inherit` would hand a lane every repo secret and undo the
  // per-lane credential isolation the lane files exist to provide.
  if (/secrets:\s*inherit/u.test(release))
    errors.push(
      "release.yml must not use `secrets: inherit` — each lane declares the secrets it accepts"
    );

  const jobs = jobBlocks(release);
  if (jobs.size === 0) {
    errors.push("release.yml has no parseable jobs mapping");
    return errors;
  }

  // (5) Every lane file is reachable from release.yml, and every lane job
  // points at a file that exists.
  const laneFiles = files.filter((name) => name.startsWith("lane-release-"));
  const calledLanes = new Map();
  for (const [id, body] of jobs) {
    const uses = /uses:\s*\.\/\.github\/workflows\/(?<file>[\w.-]+)/u.exec(
      body
    );
    if (uses?.groups?.file) calledLanes.set(id, uses.groups.file);
  }
  for (const [id, file] of calledLanes) {
    if (!files.includes(file))
      errors.push(`release.yml job ${id} calls missing workflow ${file}`);
  }
  for (const lane of laneFiles) {
    if (![...calledLanes.values()].includes(lane))
      errors.push(
        `${lane} is never called by release.yml — an orphan release lane can never run`
      );
  }

  // (6) A lane is reusable-only. A lane with its own trigger would resurrect
  // the pre-#557 "one tag, four runs" split.
  for (const lane of laneFiles) {
    const text = stripComments(
      readFileSync(path.join(workflowDir, lane), "utf8")
    );
    if (!/^on:\s*\n\s+workflow_call:/mu.test(text))
      errors.push(`${lane} must declare \`on: workflow_call\``);
    for (const trigger of ["push:", "pull_request:", "schedule:"]) {
      if (new RegExp(`^\\s{2}${trigger}`, "mu").test(text))
        errors.push(
          `${lane} declares its own ${trigger} trigger — lanes are called by release.yml only`
        );
    }
  }

  // (7) Secret isolation: a lane can only receive what it declares.
  for (const [id, lane] of calledLanes) {
    if (!files.includes(lane)) continue;
    const declared = declaredLaneSecrets(
      stripComments(readFileSync(path.join(workflowDir, lane), "utf8"))
    );
    for (const secret of forwardedSecrets(jobs.get(id) ?? "")) {
      if (!declared.has(secret))
        errors.push(
          `release.yml job ${id} forwards ${secret}, which ${lane} does not declare under on.workflow_call.secrets`
        );
    }
  }

  // (8) THE aggregator-completeness property. `release-check` is the single
  // red/green for a release; a lane missing from its `needs:` is a surface that
  // can fail while the release reports success.
  const check = jobs.get("release-check");
  if (check) {
    const needs = /needs:\s*\[(?<list>[^\]]*)\]/u.exec(check);
    const declared = new Set(
      (needs?.groups?.list ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    );
    for (const id of jobs.keys()) {
      if (id === "release-check") continue;
      if (!declared.has(id))
        errors.push(
          `release-check.needs is missing job ${id} — that lane could fail while the release reports success`
        );
    }
    if (!/if:\s*always\(\)/u.test(check))
      errors.push(
        "release-check must run with `if: always()` or a failed lane skips the aggregator entirely"
      );
    // `skipped` passes (a companion-only tag skips every product lane);
    // `cancelled` must fail — a dead runner is not a pass. Compare the whole
    // passing case arm, not a substring: `success | skipped | cancelled` still
    // contains `success | skipped`, and that widening is precisely the change
    // this assertion exists to stop.
    const arm = /\n\s*(?<arm>[^\n)]*?)\)\s*;;/u.exec(check);
    if (arm?.groups?.arm.trim() !== "success | skipped")
      errors.push(
        "release-check must treat only `success` and `skipped` as passing results"
      );
    if (!/refusing to pass/u.test(check))
      errors.push(
        "release-check must fail closed when it receives no lane results"
      );
  } else {
    errors.push("release.yml missing the release-check aggregator job");
  }

  // (9) The mobile store lane is opt-in by name (J7). Accepting `all` would let
  // a desktop repackage burn EAS quota and auto-submit to TestFlight/Play.
  const mobile = jobs.get("mobile");
  if (mobile) {
    const condition = /if:\s*>?(?<body>[\s\S]*?)\n\s{4}[a-z]/u.exec(mobile);
    const text = condition?.groups?.body ?? "";
    if (!/surfaces\s*==\s*'mobile'/u.test(text))
      errors.push("mobile lane must require surfaces == 'mobile' exactly");
    if (/surfaces\s*==\s*'all'/u.test(text))
      errors.push(
        "mobile lane must NOT accept surfaces == 'all' — store submission stays opt-in (J7)"
      );
    if (!/event_name\s*==\s*'workflow_dispatch'/u.test(text))
      errors.push(
        "mobile lane must be reachable only from workflow_dispatch, never a pushed tag"
      );
  } else {
    errors.push("release.yml missing the mobile lane job");
  }

  // (10) Per-job permissions REPLACE the workflow block, so a lane that widens
  // must restate what it still needs.
  const npm = jobs.get("gateway-npm");
  if (npm) {
    if (!/id-token:\s*write/u.test(npm))
      errors.push(
        "gateway-npm job needs `id-token: write` for `npm publish --provenance`"
      );
    if (!/contents:\s*read/u.test(npm))
      errors.push(
        "gateway-npm job must restate `contents: read` — job permissions replace the workflow block"
      );
  } else {
    errors.push("release.yml missing the gateway-npm lane job");
  }
  const desktop = jobs.get("desktop");
  if (desktop && !/contents:\s*write/u.test(desktop))
    errors.push(
      "desktop job needs `contents: write` to create the GitHub release"
    );

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const errors = lintReleaseWiring();
  if (errors.length) {
    for (const error of errors) console.error(`release-wiring: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      "release-wiring: one tag entry point, every lane reachable and reusable-only, release-check aggregates every lane, mobile stays opt-in, secrets stay per-lane"
    );
  }
}
