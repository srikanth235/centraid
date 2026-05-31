/*
 * SKILL.md discovery, frontmatter parsing, and body composition.
 *
 * The grounding "skills" are static markdown units under `<pkg>/skills/<name>/
 * SKILL.md`, each with YAML frontmatter (`name` + `description`) — the
 * Anthropic Agent Skill format, so both agent backends can discover and
 * progressively disclose them from disk.
 *
 * `composeSkills()` is the phase-1 delivery: it concatenates the named skills'
 * bodies into one string the gateway appends to a turn's instructions. This is
 * byte-equivalent to the old `CENTRAID_APPEND_PROMPT` / `AUTOMATION_APPEND_PROMPT`
 * constants, just sourced from editable markdown. It also doubles as the
 * safety-valve path once native progressive disclosure is wired on each backend.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Metadata parsed from a skill's `SKILL.md` frontmatter. */
export interface SkillMeta {
  /** The `name` frontmatter field (matches the directory name). */
  name: string;
  /** The `description` frontmatter field — what the model selects on. */
  description: string;
  /** Absolute path to the skill's `SKILL.md`. */
  path: string;
}

const SKILL_FILE = 'SKILL.md';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Absolute path to the package's `skills/` catalog. Resolves the same from
 * compiled `dist/` and from `tsx`-run `src/`: the loader file sits one level
 * under the package root in both layouts, so its grandparent is the package
 * root.
 */
export function skillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(path.dirname(here), 'skills');
}

/** Split a `SKILL.md` into its frontmatter map and its markdown body. */
export function parseSkillFile(raw: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** List the on-disk skills with their `{name, description, path}` metadata. */
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
      raw = readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }
    const { meta } = parseSkillFile(raw);
    out.push({ name: meta.name ?? entry, description: meta.description ?? '', path: skillPath });
  }
  return out;
}

/**
 * Concatenate the bodies (frontmatter stripped) of the named skills, in the
 * given order, joined by a blank line. Throws when a name has no `SKILL.md` —
 * a missing grounding skill is a programming error, not a soft-fail.
 */
export function composeSkills(names: readonly string[], dir: string = skillsDir()): string {
  return names
    .map((name) => {
      const raw = readFileSync(path.join(dir, name, SKILL_FILE), 'utf8');
      return parseSkillFile(raw).body;
    })
    .join('\n\n');
}
