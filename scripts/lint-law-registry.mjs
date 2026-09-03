#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const TAG_RE = /\[law:(?<tag>[^\]]*)\]/gu;
const VALID_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  ".expo",
  "coverage",
  "artifacts",
  ".claude",
  ".app-boot",
  ".stryker-tmp",
]);

const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js|jsx)$/u;

const SELF_TEST = "scripts/lint-law-registry.test.mjs";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEST_FILE_RE.test(name)) out.push(full);
  }
  return out;
}

export function collectLawTags(scanRoot = root) {
  const found = [];
  for (const file of walk(scanRoot)) {
    const rel = path.relative(scanRoot, file).split(path.sep).join("/");
    if (rel === SELF_TEST) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      TAG_RE.lastIndex = 0;
      let match = TAG_RE.exec(line);
      while (match !== null) {
        found.push({
          tag: match.groups.tag,
          file: rel,
          line: index + 1,
          valid: VALID_TAG_RE.test(match[1]),
        });
        match = TAG_RE.exec(line);
      }
    }
  }
  return found;
}

export function checkLawRegistry({ laws, tags, flowIds = [], files = [] }) {
  const violations = [];
  const notices = [];
  const registryDeclared = laws !== undefined && laws !== null;

  for (const tag of tags) {
    if (!tag.valid) {
      violations.push(
        `${tag.file}:${tag.line}: malformed law tag "[law:${tag.tag}]" — tags are kebab-case, e.g. [law:backup-no-change]`
      );
    }
  }

  const filesByTag = new Map();
  for (const tag of tags.filter((t) => t.valid)) {
    if (!filesByTag.has(tag.tag)) filesByTag.set(tag.tag, new Map());
    const perFile = filesByTag.get(tag.tag);
    if (!perFile.has(tag.file)) perFile.set(tag.file, tag.line);
  }

  for (const [tag, perFile] of [...filesByTag].sort()) {
    if (perFile.size > 1) {
      const where = [...perFile]
        .map(([file, line]) => `${file}:${line}`)
        .sort()
        .join(", ");
      violations.push(
        `law "${tag}" is claimed by ${perFile.size} files (${where}) — one law, one home. Strengthen the owner and delete the restatement, or split the law in two and register both.`
      );
    }
  }

  if (!registryDeclared) {
    if (filesByTag.size > 0) {
      notices.push(
        `tests/claims.json has no "laws" key; ${filesByTag.size} law tag(s) are in use. Duplicate-owner checking is active; owner and orphan checking is NOT until the key lands.`
      );
    }
    return { violations, notices };
  }

  const known = new Set(Object.keys(laws));
  const fileSet = new Set(files);

  for (const [tag, perFile] of [...filesByTag].sort()) {
    if (!known.has(tag)) {
      const first = [...perFile][0];
      violations.push(
        `${first[0]}:${first[1]}: law tag "${tag}" is not in tests/claims.json#laws — register it (statement + owner) or remove the tag.`
      );
      continue;
    }
    const declaredOwner = laws[tag].owner;
    for (const [file, line] of perFile) {
      if (file !== declaredOwner) {
        violations.push(
          `${file}:${line}: law "${tag}" is owned by ${declaredOwner} — a second file asserting it is a restatement, not coverage.`
        );
      }
    }
  }

  for (const [tag, entry] of Object.entries(laws).sort()) {
    if (!entry || typeof entry.owner !== "string" || entry.owner === "") {
      violations.push(`law "${tag}": registry entry has no "owner" file.`);
      continue;
    }
    if (typeof entry.statement !== "string" || entry.statement.trim() === "") {
      violations.push(
        `law "${tag}": registry entry has no "statement" — a tag with no stated law cannot be checked by a reader.`
      );
    }
    if (fileSet.size > 0 && !fileSet.has(entry.owner)) {
      violations.push(
        `law "${tag}": owner ${entry.owner} does not exist in the test tree.`
      );
    }
    if (!filesByTag.has(tag)) {
      violations.push(
        `law "${tag}": registered to ${entry.owner}, but no test title there carries [law:${tag}] — the registry is describing a test that does not exist.`
      );
    }
    if (
      entry.flow !== undefined &&
      flowIds.length > 0 &&
      !flowIds.includes(entry.flow)
    ) {
      violations.push(
        `law "${tag}": flow "${entry.flow}" is not a derived flow id (scripts/test-report/derive-flows.mjs).`
      );
    }
  }

  return { violations, notices };
}

function main() {
  const matrix = JSON.parse(
    readFileSync(path.join(root, "tests", "claims.json"), "utf8")
  );
  const tags = collectLawTags(root);
  const files = walk(root).map((file) =>
    path.relative(root, file).split(path.sep).join("/")
  );
  const { violations, notices } = checkLawRegistry({
    laws: matrix.laws,
    tags,
    flowIds: (matrix.flows ?? []).map((flow) => flow.id),
    files,
  });
  for (const notice of notices) {
    process.stderr.write(`law registry NOTICE: ${notice}\n`);
  }
  if (violations.length > 0) {
    process.stderr.write(`law registry (#656):\n${violations.join("\n")}\n`);
    process.exit(1);
  }
  const registered = Object.keys(matrix.laws ?? {}).length;
  process.stdout.write(
    `law registry: ok (${registered} laws registered, ${tags.length} tag site(s))\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
