#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github/workflows");

const SHA_PINNED = /^[^@\s]+@[0-9a-f]{40}\s*(?:#.*)?$/u;
const errors = [];

function exemptUses(ref) {
  if (ref.startsWith("./")) return true;
  if (ref.startsWith("docker://")) return true;
  return false;
}

function isClosedOnlyPullRequestTrigger(lines, pullRequestLineIndex) {
  let sawTypes = false;
  let typesBlob = "";
  for (let i = pullRequestLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (/^ {0,2}\S/u.test(line)) break;
    const typesMatch = /^ {4}types:\s*(?<rest>.*)$/u.exec(line);
    if (typesMatch) {
      sawTypes = true;
      typesBlob = typesMatch.groups?.rest ?? "";
      if (typesBlob === "" || typesBlob.startsWith("#")) {
        let j = i + 1;
        const items = [];
        while (j < lines.length && /^ {6}-\s+\S/u.test(lines[j])) {
          items.push(
            lines[j]
              .replace(/^ {6}-\s+/u, "")
              .replace(/\s+#.*$/u, "")
              .trim()
          );
          j += 1;
        }
        typesBlob = `[${items.join(", ")}]`;
      }
      break;
    }
    if (/^ {4}\S/u.test(line)) return false;
  }
  if (!sawTypes) return false;
  const normalized = typesBlob.replace(/\s+#.*$/u, "").replace(/\s+/gu, "");
  return normalized === "[closed]";
}

export function lintWorkflowSource(name, source) {
  const found = [];
  const lines = source.split("\n");

  // governance-kit-managed workflows are digest-owned; policy fixes go upstream.
  if (/^#\s*governance-kit:managed/mu.test(source)) {
    console.log(
      `workflow-pins: ${name} is governance-kit:managed — policy is upstream, skipping`
    );
    return found;
  }

  let job = null;
  const jobs = [];
  let inJobs = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;
    const trimmed = line.trim();

    if (/^jobs:\s*$/u.test(line)) inJobs = true;
    if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/u.test(line)) {
      job = {
        name: trimmed.slice(0, -1),
        line: lineNo,
        hasTimeout: false,
        callsWorkflow: false,
      };
      jobs.push(job);
    }
    if (job && /^ {4}timeout-minutes:/u.test(line)) job.hasTimeout = true;
    if (job && /^ {4}uses:/u.test(line)) job.callsWorkflow = true;

    const uses = /^\s*(?:-\s*)?uses:\s*(?<ref>\S+)/u.exec(line);
    if (uses) {
      const ref = uses.groups?.ref ?? "";
      if (
        !exemptUses(ref) &&
        !SHA_PINNED.test(`${ref} ${trimmed.split("#")[1] ?? ""}`.trim())
      ) {
        if (!/@[0-9a-f]{40}$/u.test(ref)) {
          found.push(
            `${name}:${lineNo} uses a floating ref \`${ref}\` — pin to a 40-char SHA with a trailing \`# vX.Y.Z\` comment`
          );
        }
      }
    }

    if (
      /^\s*(?:-\s*)?uses:\s*dtolnay\/rust-toolchain@[0-9a-f]{40}/u.test(line)
    ) {
      const indent = line.length - line.trimStart().length;
      let declared = false;
      for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
        const next = lines[ahead];
        if (next.trim() === "") continue;
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent < indent) break;
        if (nextIndent === indent && next.trimStart().startsWith("- ")) break;
        if (/^\s*toolchain:\s*\S/u.test(next)) {
          declared = true;
          break;
        }
      }
      if (!declared) {
        found.push(
          `${name}:${lineNo} pins dtolnay/rust-toolchain by SHA without \`with: toolchain: …\` — the action reads its toolchain from its own ref, and a SHA has none, so it exits 1 before installing`
        );
      }
    }

    if (/^\s*bun-version:/u.test(line)) {
      found.push(
        `${name}:${lineNo} hardcodes a Bun version — use \`uses: ./.github/actions/setup\`, which reads packageManager`
      );
    }

    if (/^\s*(?:-\s*)?(?:run:\s*)?bun install\b/u.test(line)) {
      found.push(
        `${name}:${lineNo} runs \`bun install\` by hand — use \`uses: ./.github/actions/setup\` (install is on by default)`
      );
    }

    if (
      /^\s{2}pull_request:/u.test(line) &&
      name !== ".github/workflows/ci.yml" &&
      !isClosedOnlyPullRequestTrigger(lines, index)
    ) {
      found.push(
        `${name}:${lineNo} listens on \`pull_request\` — only ci.yml may (open PR events). Add a job there (gated on the \`changes\` filter) so it rolls up into the required \`check\`, or expose this workflow via \`workflow_call\` and invoke it from ci.yml. Post-merge-only listeners must use \`types: [closed]\``
      );
    }

    if (
      !inJobs &&
      /^ {4}tags:/u.test(line) &&
      name !== ".github/workflows/release.yml"
    ) {
      found.push(
        `${name}:${lineNo} listens on \`push: tags\` — only release.yml may. Expose this workflow via \`workflow_call\` and add a lane to release.yml so the tag produces one run with one \`release-check\` verdict`
      );
    }
  }

  for (const entry of jobs) {
    if (!entry.hasTimeout && !entry.callsWorkflow) {
      found.push(
        `${name}:${entry.line} job \`${entry.name}\` has no timeout-minutes (inherits GitHub's 360-minute default)`
      );
    }
  }

  return found;
}

function lintSetupAction() {
  const found = [];
  const actionPath = path.join(root, ".github/actions/setup/action.yml");
  let source;
  try {
    source = readFileSync(actionPath, "utf8");
  } catch {
    return [
      ".github/actions/setup/action.yml is missing — workflows reference it",
    ];
  }
  if (!source.includes("packageManager")) {
    found.push(
      ".github/actions/setup must derive the version from packageManager"
    );
  }
  if (!/oven-sh\/setup-bun@[0-9a-f]{40}/u.test(source)) {
    found.push(".github/actions/setup must pin oven-sh/setup-bun to a SHA");
  }
  return found;
}

function lintPackageManager() {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (!/^bun@\d+\.\d+\.\d+$/u.test(pkg.packageManager ?? "")) {
    return [
      `package.json packageManager must be \`bun@<x.y.z>\`, got \`${pkg.packageManager}\``,
    ];
  }
  return [];
}

function main() {
  errors.push(...lintPackageManager(), ...lintSetupAction());

  const files = readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  for (const file of files) {
    const source = readFileSync(path.join(workflowDir, file), "utf8");
    errors.push(...lintWorkflowSource(`.github/workflows/${file}`, source));
  }

  if (errors.length) {
    for (const error of errors) console.error(`workflow-pins: ${error}`);
    console.error(`workflow-pins: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `workflow-pins: ${files.length} workflow(s) clean (SHA pins, bun pin, timeouts, no hand-rolled install, single PR + release entry point)`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
