import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

const SKILL_FILE = "SKILL.md";
const FRONTMATTER_RE = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---\r?\n?/u;

/** Gateway `skills/` catalog; same path from dist/ and src/ layouts. */
export function skillsDir(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url).href);
}

export function parseSkillFile(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of (m.groups?.frontmatter ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

export function listSkills(dir: string = skillsDir()): SkillMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const entry of entries.sort()) {
    const skillPath = path.join(dir, entry, SKILL_FILE);
    let raw: string;
    try {
      if (!statSync(path.join(dir, entry)).isDirectory()) continue;
      raw = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const { meta } = parseSkillFile(raw);
    out.push({
      name: meta.name ?? entry,
      description: meta.description ?? "",
      path: skillPath,
    });
  }
  return out;
}

/**
 * Concatenate the named skills' bodies, in order. Throws on a missing
 * `SKILL.md` — that is a programming error, not a soft-fail.
 */
export function composeSkills(
  names: readonly string[],
  dir: string = skillsDir()
): string {
  return names
    .map((name) => {
      const raw = readFileSync(path.join(dir, name, SKILL_FILE), "utf8");
      return parseSkillFile(raw).body;
    })
    .join("\n\n");
}
