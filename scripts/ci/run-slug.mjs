#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export function toRunDate(createdAt, fallbackNow) {
  const candidate = String(createdAt ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) {
    const parsed = new Date(`${candidate}T00:00:00Z`);
    if (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === candidate
    ) {
      return candidate;
    }
  }
  return fallbackNow.toISOString().slice(0, 10);
}

export function toSlug(date, runId) {
  return `${date}-${runId}`;
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };
  const repo = flag("repo");
  const runId = flag("run-id");
  if (!repo || !runId) throw new Error("--repo and --run-id are required");

  const probe = spawnSync(
    "gh",
    ["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".created_at"],
    {
      encoding: "utf8",
    }
  );
  const createdAt = probe.status === 0 ? probe.stdout.trim() : "";

  const date = toRunDate(createdAt, new Date());
  const slug = toSlug(date, runId);

  console.log(`date=${date}`);
  console.log(`slug=${slug}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `date=${date}\nslug=${slug}\n`);
  }
}

if (process.argv[1] && process.argv[1].endsWith("run-slug.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
