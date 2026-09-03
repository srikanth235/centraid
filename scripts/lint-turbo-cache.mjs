#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

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

export function globToRegExp(glob) {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (i + 2 >= glob.length) {
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

function trackedPaths() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

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
        // Intentionally empty.
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
