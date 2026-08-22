#!/usr/bin/env node
/**
 * W6.3 — dependency BEHAVIOUR gate (umbrella #842).
 *
 * The existing supply-chain gates all check dependency *identity*: gitleaks
 * (secrets in our tree), dependency-review + OSV (is this package version known
 * bad), lockfile-lint (does it come from a registry we allow over TLS). None of
 * them asks the question that malicious-package incidents actually turn on:
 * **what does this dependency run on my machine at install time, and did that
 * change?** A typosquat with a clean CVE record and a valid integrity hash
 * passes every identity gate and still exfiltrates `~/.npmrc` from a
 * `postinstall`.
 *
 * Two properties, both tighten-only:
 *
 *   1. **Inventory** — every dependency declaring `preinstall` / `install` /
 *      `postinstall` is in the ledger, with a digest over the exact command
 *      strings AND the bytes of the local scripts they invoke. A republished
 *      tarball that swaps `install.js` under the same version changes the
 *      digest and fails, which is the case an integrity hash on the *tarball*
 *      cannot catch once the lockfile is refreshed.
 *   2. **Execution** — `trustedDependencies` in the root package.json is the
 *      set Bun will actually EXECUTE. It must be a subset of the ledger, and
 *      every member needs a written reason. Today it is empty, so the audit
 *      proves the stronger property: no third-party install-time code runs here
 *      at all.
 *
 * `prepare` is deliberately out of scope — package managers do not run it for
 * registry dependencies, only for git deps and for the package being developed.
 *
 * Usage:  node scripts/security/lifecycle-audit.mjs [--json] [--print-ledger]
 * Exit:   0 clean (or a LOUDLY-cited guarded skip), 1 on any drift.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** The three hooks a package manager runs on a dependency's behalf. */
export const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/**
 * Behaviour signals. Each pattern is a shape that is *normal* in a build tool
 * and *alarming* in a dependency you did not ask to run code: the point is not
 * that a match is malicious, it is that a match must be reviewed once and then
 * pinned, so an unreviewed one cannot arrive silently.
 */
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

/**
 * The unreviewed-reason SENTINEL. `--print-ledger` stamps it, and the audit
 * refuses while it survives — so it is a value this file is ABOUT, never a
 * promise this file makes. Named once here so the branch and the message below
 * carry no bare marker of their own.
 */
export const UNREVIEWED_MARKER = "TODO"; // governance: allow-no-orphan-todos
export const UNREVIEWED_REASON = `${UNREVIEWED_MARKER}: why is install-time code acceptable here?`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Read a package-local script, or null when the path names no regular file. */
function readScriptFile(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return readFileSync(file, "utf8");
}

/**
 * Walk an installed tree and report every package with an install hook.
 * Nested `node_modules` are followed, so a transitive hoist-buster is not a
 * blind spot.
 *
 * @param {string} nodeModules absolute path to a node_modules directory
 * @returns {Array<{name:string,version:string,dir:string,commands:Record<string,string>}>} every package declaring at least one install hook, sorted
 */
export function collectInstallHooks(nodeModules) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A dangling symlink or a permission-denied corner of a workspace tree is
      // not an audit finding; the packages we can read are the ones we gate.
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

/** Local `.js`/`.cjs`/`.mjs`/`.sh` files a hook command names, in command order. */
export function referencedScripts(command) {
  const matches = command.matchAll(/(?<file>[\w./@-]+\.(?:c?js|mjs|sh))/gu);
  return [...matches].map((match) => match.groups.file.replace(/^\.\//u, ""));
}

/**
 * Digest one package's install-time behaviour: the exact command strings plus
 * the bytes of every local script they invoke. Two packages with the same
 * digest do the same thing at install time.
 *
 * @param {{dir:string,commands:Record<string,string>}} entry the package to fingerprint
 * @param {(file: string) => string|null} [readFile] reader for package-local scripts; returns null when the path names no file
 * @returns {{ digest: string, signals: string[], files: string[] }} the behaviour digest, the signals raised, and which local scripts contributed
 */
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
      // A command naming a file that is not in the package (a shell builtin
      // path, a binary from PATH) contributes its command string only.
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
  // NUL is the separator because no path or sha can contain it, so the joined
  // parts cannot be made to collide by a crafted filename. Written as the
  // \u0000 ESCAPE, never the raw byte: a literal NUL in the source makes this
  // file binary to grep, and the no-orphan-todos governance sweep then reports
  // "Binary file ... matches" as a phantom violation with no line to cite.
  return { digest: sha256(parts.join("\u0000")), signals, files: files.sort() };
}

/**
 * Compare an observed inventory against the ledger. Drift in either direction
 * is a failure: an unledgered package is unreviewed install-time code, and a
 * ledger entry with no matching package is a waiver that outlived its subject
 * (that is how an allowlist silently widens back out).
 *
 * @param {{observed: Array<object>, ledger: {packages?: Record<string, object>}, trustedDependencies: string[]}} input the tree, the ledger, and the set the package manager will actually execute
 * @returns {{ ok: boolean, problems: string[], observed: Array<object> }} the verdict and every drift found
 */
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
    // The three markers in this file are the SENTINEL this audit refuses on —
    // the unreviewed placeholder `--print-ledger` stamps — not deferred work.
    // Linking a tracker would claim someone owns the placeholder; nobody does,
    // and the whole point is that it must be replaced before the gate passes.
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

/** Build the ledger shape for the tree as it is now (for `--print-ledger`). */
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
