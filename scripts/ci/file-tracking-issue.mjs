#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function parseArgs(argv) {
  const known = new Set(["title", "search", "body-file", "label", "run-url"]);
  const booleans = new Set(["update"]);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--"))
      throw new Error(`unexpected argument \`${token}\``);
    const key = token.slice(2);
    if (booleans.has(key)) {
      out[key] = true;
      continue;
    }
    if (!known.has(key)) throw new Error(`unknown flag \`--${key}\``);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`--${key} needs a value`);
    out[key] = value;
    index += 1;
  }
  for (const required of ["title", "search", "body-file"]) {
    if (!out[required]) throw new Error(`--${required} is required`);
  }
  return out;
}

export function buildSearchQuery(search) {
  return `in:title ${search}`;
}

export function parseExistingNumber(stdout) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed || trimmed === "null") return null;
  if (!/^\d+$/u.test(trimmed)) return null;
  return Number(trimmed);
}

export function findExactTitleNumber(stdout, title) {
  const trimmed = (stdout ?? "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (entry && typeof entry === "object" && entry.title === title) {
      const number = Number(entry.number);
      if (Number.isInteger(number) && number > 0) return number;
    }
  }
  return null;
}

export function updateTrackingIssue({ run, title, search, body, label }) {
  const found = run([
    "issue",
    "list",
    "--search",
    buildSearchQuery(search),
    "--state",
    "open",
    "--limit",
    "50",
    "--json",
    "number,title",
  ]);
  const existing =
    found.status === 0 ? findExactTitleNumber(found.stdout, title) : null;

  if (existing !== null) {
    const edited = run(["issue", "edit", String(existing), "--body", body]);
    if (edited.status !== 0) {
      return {
        ok: false,
        action: "edit",
        number: existing,
        error: edited.stderr,
      };
    }
    return { ok: true, action: "edit", number: existing };
  }
  return createTrackingIssue({ run, title, body, label });
}

export function createTrackingIssue({ run, title, body, label }) {
  if (label) {
    const labelled = run([
      "issue",
      "create",
      "--title",
      title,
      "--body",
      body,
      "--label",
      label,
    ]);
    if (labelled.status === 0)
      return { ok: true, action: "create", labelled: true };
  }
  const plain = run(["issue", "create", "--title", title, "--body", body]);
  if (plain.status !== 0) {
    return { ok: false, action: "create", error: plain.stderr };
  }
  return { ok: true, action: "create", labelled: false };
}

export function fileTrackingIssue({ run, title, search, body, label, runUrl }) {
  const found = run([
    "issue",
    "list",
    "--search",
    buildSearchQuery(search),
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number",
  ]);
  const existing =
    found.status === 0 ? parseExistingNumber(found.stdout) : null;

  if (existing !== null) {
    const commented = run([
      "issue",
      "comment",
      String(existing),
      "--body",
      body,
    ]);
    if (commented.status !== 0) {
      return {
        ok: false,
        action: "comment",
        number: existing,
        error: commented.stderr,
      };
    }
    return { ok: true, action: "comment", number: existing };
  }

  const created = createTrackingIssue({ run, title, body, label });
  return created.ok ? created : { ...created, runUrl };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const body = readFileSync(args["body-file"], "utf8");
  const run = (argv) => {
    const result = spawnSync("gh", argv, { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  const result = args.update
    ? updateTrackingIssue({
        run,
        title: args.title,
        search: args.search,
        body,
        label: args.label,
      })
    : fileTrackingIssue({
        run,
        title: args.title,
        search: args.search,
        body,
        label: args.label,
        runUrl: args["run-url"],
      });

  if (!result.ok) {
    const where = result.number ? ` #${result.number}` : "";
    console.error(
      `::error::Failed to ${result.action} tracking issue${where} — run ${args["run-url"] ?? "(unknown)"}`
    );
    if (result.error) console.error(result.error);
    process.exitCode = 1;
    return;
  }
  if (result.action === "comment" || result.action === "edit")
    console.log(
      `${result.action === "edit" ? "Rewrote" : "Commented on"} issue #${result.number}`
    );
  else
    console.log(
      `Opened tracking issue${result.labelled ? " (labelled)" : " (unlabelled fallback)"}`
    );
}

if (process.argv[1] && process.argv[1].endsWith("file-tracking-issue.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
