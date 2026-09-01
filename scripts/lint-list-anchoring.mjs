#!/usr/bin/env node
// Virtualized lists must declare their scroll anchoring (#903).
//
// FlashList v2 anchors visible content by default. Every native seat sorts
// newest first, so a row arriving from another device is inserted at the top
// and the anchor scrolls it out of sight above the fold — drawn, counted in the
// footer, and invisible. A re-sorted row leaves the viewport the same way,
// which reads as a document that vanished. `NEWEST_FIRST_ANCHORING` is the one
// answer; a list that wants different behaviour states it in place, so the
// choice is always visible at the call site rather than inherited by default.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_SRC = path.join(ROOT, "apps", "mobile", "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".expo", "test"]);
const PROP = "maintainVisibleContentPosition";

/** Every non-test source file under the mobile seat. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
      continue;
    }
    if (!/\.tsx?$/u.test(entry)) continue;
    if (/\.test\.tsx?$/u.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Each `<FlashList` opening tag, paired with the props text up to its `>`.
 * Crude but sufficient: the tag is always written open-ended in this codebase,
 * and a false negative here is a list that silently swallows new rows.
 */
function flashListTags(src) {
  const tags = [];
  const opener = /<FlashList\b/gu;
  let match;
  while ((match = opener.exec(src)) !== null) {
    const rest = src.slice(match.index);
    const end = rest.indexOf(">");
    tags.push({
      line: src.slice(0, match.index).split("\n").length,
      props: end === -1 ? rest : rest.slice(0, end),
    });
  }
  return tags;
}

const failures = [];
for (const file of sources(MOBILE_SRC)) {
  const src = readFileSync(file, "utf8");
  if (!src.includes("<FlashList")) continue;
  for (const tag of flashListTags(src)) {
    if (tag.props.includes(PROP)) continue;
    failures.push(`${path.relative(ROOT, file)}:${tag.line}`);
  }
}

if (failures.length > 0) {
  console.error(
    `list-anchoring: ${failures.length} FlashList site(s) declare no ${PROP}.`
  );
  console.error(
    "Import NEWEST_FIRST_ANCHORING from kit/components/list-anchoring, or state"
  );
  console.error("this list's own anchoring inline. See #903.");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log("ok   list-anchoring — every FlashList declares its anchoring");
