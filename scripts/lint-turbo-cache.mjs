#!/usr/bin/env node
/**
 * Turbo cache-correctness linter (#892 Phase 0).
 *
 * ONE RULE: no task may declare an output that is a git-TRACKED path.
 *
 * Why it is worth a gate. Turbo hashes a package's tracked files to build a
 * task's cache key, and it writes a task's declared `outputs` into the cache
 * artifact. When a path is both, the task's key depends on the task's own
 * product: a cache hit overwrites the committed file with the cached copy, a
 * rebuild that is not byte-exact moves the key, and the entry carries the file's
 * bytes on every save and restore whether or not the build produced them. Turbo
 * documents the overlap as undefined behaviour, and — this is the part that
 * makes it a linter rather than a comment — it never errors. It just stops
 * caching, which is indistinguishable from "the build is slow".
 *
 * This is exactly what `src/generated/centraid_web_iroh_bg.wasm` was: a
 * committed 1.9 MB artifact listed as an output of the generic `build` task, so
 * every package's build cache entry was shaped by it and `@centraid/web`'s
 * carried it.
 *
 * Offline, no turbo invocation, ~30 ms: it reads `turbo.json` and asks git which
 * of the resolved paths are tracked. It belongs next to the other repo linters
 * on the per-PR loop.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

/** Strip `//` line comments so JSON.parse accepts turbo's JSONC. */
export function stripJsonComments(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Compile one turbo output glob to a RegExp.
 *
 * Hand-rolled rather than pulled from a matcher package on purpose: turbo's
 * output syntax here is `dist/**`, `native/*.node` and literal paths, and adding
 * a dependency to a repo linter that `knip` audits for undeclared deps costs
 * more than the twelve lines it saves. `**` crosses separators, `*` and `?` do
 * not; a leading `!` is turbo's negation and is handled by the caller.
 */
export function globToRegExp(glob) {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (i + 2 >= glob.length) {
        // Trailing `dir/**` covers the directory itself and everything beneath
        // it, which is how turbo treats an output tree.
        if (source.endsWith("/")) source = `${source.slice(0, -1)}(?:/.*)?`;
        else source += ".*";
        i += 2;
        continue;
      }
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 3;
        continue;
      }
      source += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += ch.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    i += 1;
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * Tracked paths a declared output would cover, resolved against each workspace.
 *
 * @param {string} glob a turbo `outputs` entry, package-relative
 * @param {string[]} packageDirs repo-relative workspace directories
 * @param {string[]} tracked repo-relative tracked paths
 * @returns {string[]} the offenders
 */
export function trackedMatches(glob, packageDirs, tracked) {
  if (glob.startsWith("!")) return [];
  const patterns = packageDirs.map((dir) => globToRegExp(`${dir}/${glob}`));
  return tracked.filter((file) => patterns.some((re) => re.test(file)));
}

export function lintTurboOutputs(turboConfig, packageDirs, tracked) {
  const errors = [];
  for (const [task, definition] of Object.entries(turboConfig.tasks ?? {})) {
    for (const glob of definition?.outputs ?? []) {
      const offenders = trackedMatches(glob, packageDirs, tracked);
      if (offenders.length === 0) continue;
      errors.push(
        `turbo.json task \`${task}\` declares output \`${glob}\`, which covers ${offenders.length} git-TRACKED path(s) ` +
          `(e.g. ${offenders.slice(0, 3).join(", ")}). A tracked path is also one of the task's hashed inputs, so the ` +
          `task's cache key depends on its own product — turbo calls that undefined and it silently stops caching. ` +
          `Either gitignore the artifact or drop it from \`outputs\`.`
      );
    }
  }
  return errors;
}

/** Repo-relative tracked paths. */
function trackedPaths() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

/**
 * Workspace directories, from the root package.json `workspaces` globs.
 *
 * Bun accepts both the array form and the `{ packages: [...] }` object form
 * (this repo uses the latter, because it also carries a `catalog:`), so accept
 * either rather than silently resolving no workspaces and passing vacuously.
 */
export function workspaceDirs(workspaces, listDir) {
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : (workspaces?.packages ?? []);
  if (patterns.length === 0) {
    throw new Error(
      "package.json declares no workspaces — refusing to pass without checking anything"
    );
  }
  const dirs = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*")) {
      dirs.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    for (const entry of listDir(parent)) dirs.push(`${parent}/${entry}`);
  }
  return dirs;
}

function main() {
  const source = readFileSync(path.join(root, "turbo.json"), "utf8");
  const config = JSON.parse(stripJsonComments(source));
  // A workspace whose own turbo.json extends the root one can re-introduce the
  // overlap locally, so walk those too rather than trusting the root file alone.
  const configs = [["turbo.json", config]];
  for (const workspace of ["packages", "apps"]) {
    let entries = [];
    try {
      entries = readdirSync(path.join(root, workspace));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = path.join(workspace, entry, "turbo.json");
      try {
        configs.push([
          rel,
          JSON.parse(
            stripJsonComments(readFileSync(path.join(root, rel), "utf8"))
          ),
        ]);
      } catch {
        // No per-package turbo.json is the normal case.
      }
    }
  }

  const tracked = trackedPaths();
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const packageDirs = workspaceDirs(pkg.workspaces ?? [], (dir) => {
    try {
      return readdirSync(path.join(root, dir));
    } catch {
      return [];
    }
  });
  const errors = [];
  for (const [file, cfg] of configs) {
    errors.push(
      ...lintTurboOutputs(cfg, packageDirs, tracked).map((message) =>
        message.replace("turbo.json task", `${file} task`)
      )
    );
  }

  if (errors.length) {
    for (const error of errors) console.error(`turbo-cache: ${error}`);
    console.error(`turbo-cache: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `turbo-cache: ${configs.length} turbo config(s) clean — no declared output shadows a tracked path`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
