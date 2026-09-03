#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

export const BEHAVIOUR_SIGNALS = [
  {
    id: "network-fetch",
    pattern: /\b(?:fetch|https?\.get|https?\.request|XMLHttpRequest)\s*\(/u,
  },
  {
    id: "network-tool",
    pattern: /\b(?:curl|wget|npm\s+install|bun\s+(?:add|install))\b/u,
  },
  {
    id: "process-spawn",
    pattern: /\b(?:child_process|execSync|spawnSync|execFile)\b/u,
  },
  { id: "dynamic-eval", pattern: /\b(?:eval|new\s+Function)\s*\(/u },
  {
    id: "env-harvest",
    pattern:
      /process\.env\s*(?:\[|\.)\s*['"]?(?:NPM_TOKEN|GITHUB_TOKEN|AWS_|CI_JOB_TOKEN)/u,
  },
  {
    id: "home-dir-read",
    pattern:
      /(?:\bhomedir\s*\(\)|\bUSERPROFILE\b|~?\/\.(?:npmrc|ssh|aws|gitconfig|docker)\b)/u,
  },
];

export const UNREVIEWED_MARKER = "TODO"; // governance: allow-no-orphan-todos
export const UNREVIEWED_REASON = `${UNREVIEWED_MARKER}: why is install-time code acceptable here?`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function readScriptFile(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return readFileSync(file, "utf8");
}

export function collectInstallHooks(nodeModules) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const packageDir = path.join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(packageDir);
        continue;
      }
      const manifestPath = path.join(packageDir, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const scripts = manifest.scripts ?? {};
        const commands = {};
        for (const hook of INSTALL_HOOKS)
          if (typeof scripts[hook] === "string") commands[hook] = scripts[hook];
        if (Object.keys(commands).length > 0)
          found.push({
            name: manifest.name ?? entry.name,
            version: manifest.version ?? "0.0.0",
            dir: packageDir,
            commands,
          });
      }
      const nested = path.join(packageDir, "node_modules");
      if (existsSync(nested)) visit(nested);
    }
  };
  visit(nodeModules);
  found.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name)
  );
  return found;
}

export function referencedScripts(command) {
  const matches = command.matchAll(/(?<file>[\w./@-]+\.(?:c?js|mjs|sh))/gu);
  return [...matches].map((match) => match.groups.file.replace(/^\.\//u, ""));
}

export function fingerprintHooks(entry, readFile = readScriptFile) {
  const parts = [];
  const files = [];
  const corpus = [];
  for (const hook of INSTALL_HOOKS) {
    const command = entry.commands[hook];
    if (command === undefined) continue;
    parts.push(`${hook}=${command}`);
    corpus.push(command);
    for (const relative of referencedScripts(command)) {
      const target = path.join(entry.dir, relative);
      const source = readFile(target);
      if (source === null || source === undefined) continue;
      files.push(relative);
      parts.push(`file:${relative}=${sha256(source)}`);
      corpus.push(source);
    }
  }
  const text = corpus.join("\n");
  const signals = BEHAVIOUR_SIGNALS.filter((signal) =>
    signal.pattern.test(text)
  ).map((signal) => signal.id);
  return { digest: sha256(parts.join("\u0000")), signals, files: files.sort() };
}

export function auditLifecycle(input) {
  const problems = [];
  const ledger = input.ledger.packages ?? {};
  const observed = input.observed;
  const byName = new Map(observed.map((entry) => [entry.name, entry]));

  for (const entry of observed) {
    const pinned = ledger[entry.name];
    if (pinned === undefined) {
      problems.push(
        `unledgered install-time code: ${entry.name}@${entry.version} runs ${Object.keys(entry.commands).join("/")} [${entry.signals.join(", ") || "no signals"}] — review it and add a ledger entry with a reason`
      );
      continue;
    }
    if (pinned.version !== entry.version)
      problems.push(
        `${entry.name}: ledger pins ${pinned.version}, tree has ${entry.version} — re-review the install script and re-pin`
      );
    else if (pinned.digest !== entry.digest)
      problems.push(
        `${entry.name}@${entry.version}: install-script digest changed (${pinned.digest.slice(0, 12)}… → ${entry.digest.slice(0, 12)}…) — same version, different behaviour`
      );
    const newSignals = entry.signals.filter(
      (signal) => !(pinned.signals ?? []).includes(signal)
    );
    if (newSignals.length > 0)
      problems.push(
        `${entry.name}@${entry.version}: new behaviour signal(s) ${newSignals.join(", ")}`
      );
    if (typeof pinned.reason !== "string" || pinned.reason.trim() === "")
      problems.push(
        `${entry.name}: ledger entry has no reason — a bare allowlist token is not a review`
      );
    // governance: allow-no-orphan-todos the refusal sentinel, not a deferred task
    else if (pinned.reason.includes(UNREVIEWED_MARKER))
      problems.push(
        `${entry.name}: ledger entry still carries the generated ${UNREVIEWED_MARKER} reason — \`--print-ledger\` writes the shape, a human writes the review`
      );
  }

  for (const name of Object.keys(ledger).sort())
    if (!byName.has(name))
      problems.push(
        `stale ledger entry: ${name} declares no install hook in this tree — remove it (this ledger only shrinks)`
      );

  for (const name of input.trustedDependencies) {
    if (!Object.hasOwn(ledger, name))
      problems.push(
        `trustedDependencies names ${name}, which is not in the behaviour ledger — its install script would EXECUTE unreviewed`
      );
    else if (ledger[name].executes !== true)
      problems.push(
        `trustedDependencies names ${name} but its ledger entry is not marked "executes": true`
      );
  }
  for (const [name, pinned] of Object.entries(ledger))
    if (pinned.executes === true && !input.trustedDependencies.includes(name))
      problems.push(
        `ledger marks ${name} as executing, but trustedDependencies does not list it — the ledger overstates what runs`
      );

  return { ok: problems.length === 0, problems, observed };
}

export function ledgerFor(observed, previous = {}) {
  const packages = {};
  for (const entry of observed.sort((a, b) => a.name.localeCompare(b.name)))
    packages[entry.name] = {
      version: entry.version,
      hooks: Object.keys(entry.commands),
      digest: entry.digest,
      signals: entry.signals,
      executes: previous[entry.name]?.executes === true,
      reason: previous[entry.name]?.reason ?? UNREVIEWED_REASON,
    };
  return packages;
}

function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const nodeModules = path.join(root, "node_modules");
  if (!existsSync(nodeModules)) {
    console.warn(
      "lifecycle-audit: SKIPPED — node_modules is absent, so no installed tree can be inspected"
    );
    console.warn(
      "lifecycle-audit: unblock by running `bun install --frozen-lockfile` before this gate"
    );
    process.exit(0);
  }
  const ledgerPath = path.join(import.meta.dirname, "lifecycle-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  const trustedDependencies = Array.isArray(manifest.trustedDependencies)
    ? manifest.trustedDependencies
    : [];

  const observed = collectInstallHooks(nodeModules).map((entry) => ({
    ...entry,
    ...fingerprintHooks(entry),
  }));
  if (process.argv.includes("--print-ledger")) {
    console.info(
      JSON.stringify(
        { ...ledger, packages: ledgerFor(observed, ledger.packages ?? {}) },
        null,
        2
      )
    );
    return;
  }
  const result = auditLifecycle({ observed, ledger, trustedDependencies });
  if (process.argv.includes("--json"))
    console.info(JSON.stringify(result, null, 2));
  for (const problem of result.problems)
    console.error(`lifecycle-audit: ${problem}`);
  if (!result.ok) {
    console.error(
      `lifecycle-audit: ${result.problems.length} problem(s); regenerate with --print-ledger after reviewing each script`
    );
    process.exit(1);
  }
  const executing = trustedDependencies.length;
  console.info(
    `lifecycle-audit: ${observed.length} dependency(ies) declare install-time code, all ledgered; ${executing} of them are trusted to execute`
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
)
  main();
