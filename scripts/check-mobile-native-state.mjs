#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const baseRef = process.env.CENTRAID_NATIVE_STATE_BASE ?? "origin/main";

function resolveBaseRef() {
  const candidates = [baseRef, "main", "master"];
  return (
    candidates.find((ref) => {
      try {
        execFileSync("git", ["rev-parse", "--verify", ref], {
          cwd: root,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

function changedPaths() {
  const base = resolveBaseRef();
  if (!base) {
    console.log(
      "check-mobile-native-state: no merge base ref; running native-state (safe default)"
    );
    return ["apps/mobile/"];
  }
  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", base, "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    mergeBase = base;
  }
  const committed = execFileSync(
    "git",
    ["diff", "--name-only", `${mergeBase}...HEAD`],
    { cwd: root, encoding: "utf8" }
  );
  const unstaged = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
  });
  const staged = execFileSync("git", ["diff", "--name-only", "--cached"], {
    cwd: root,
    encoding: "utf8",
  });
  return `${committed}\n${unstaged}\n${staged}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function mobileAffected(paths) {
  return paths.some((p) => p === "apps/mobile" || p.startsWith("apps/mobile/"));
}

function main() {
  const paths = changedPaths();
  if (!mobileAffected(paths)) {
    console.log(
      `check-mobile-native-state: skip (no apps/mobile/** changes vs ${baseRef})`
    );
    process.exit(0);
  }

  console.log(
    "check-mobile-native-state: apps/mobile/** affected — running ci:native-state"
  );
  const result = spawnSync(
    "bun",
    ["run", "--cwd", "apps/mobile", "ci:native-state"],
    { cwd: root, stdio: "inherit", env: process.env }
  );
  process.exit(result.status === null ? 1 : result.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
