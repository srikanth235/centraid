import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

declare const Bun: { YAML: { parse: (source: string) => unknown } };

export type SkillIssue = { file: string; message: string };

function frontmatter(source: string): string | undefined {
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
  return match?.groups?.yaml;
}

export async function checkSkills(root = process.cwd()): Promise<SkillIssue[]> {
  const skillsDir = path.join(root, ".claude", "skills");
  const entries = (await readdir(skillsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const results = await Promise.all(
    entries.map(async (directory) => {
      const relative = `.claude/skills/${directory}/SKILL.md`;
      let source: string;
      try {
        source = await readFile(path.join(root, relative), "utf8");
      } catch {
        return [{ file: relative, message: "missing SKILL.md" }];
      }

      const yaml = frontmatter(source);
      if (yaml === undefined) {
        return [{ file: relative, message: "missing YAML frontmatter" }];
      }

      let metadata: unknown;
      try {
        metadata = Bun.YAML.parse(yaml);
      } catch (error) {
        return [
          {
            file: relative,
            message: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
          },
        ];
      }
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        return [
          { file: relative, message: "frontmatter must be a YAML mapping" },
        ];
      }

      const fields = metadata as Record<string, unknown>;
      const found: SkillIssue[] = [];
      if (fields.name !== directory) {
        found.push({
          file: relative,
          message: `name must match skill directory (${directory})`,
        });
      }
      if (
        typeof fields.description !== "string" ||
        fields.description.trim() === ""
      ) {
        found.push({
          file: relative,
          message: "description must be a nonempty string",
        });
      }
      return found;
    })
  );
  return results.flat();
}

if (import.meta.main) {
  const issues = await checkSkills();
  for (const issue of issues) console.error(`${issue.file}: ${issue.message}`);
  if (issues.length > 0) process.exitCode = 1;
  else console.log("skills: frontmatter is valid for every skill");
}
