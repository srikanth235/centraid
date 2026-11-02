import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { checkSkills } from "./check-skills";

function fixture(skills: Record<string, string>): string {
  // The kit owns removal: under `bun test` its vitest `afterAll` is Bun's.
  const root = tempDirSync("centraid-skill-check-");
  for (const [name, body] of Object.entries(skills)) {
    const directory = path.join(root, ".claude", "skills", name);
    mkdirSync(directory, { recursive: true });
    if (body !== "<missing>")
      writeFileSync(path.join(directory, "SKILL.md"), body);
  }
  return root;
}

describe(checkSkills, () => {
  test("accepts block YAML containing the vault description's colon followed by a space", async () => {
    const root = fixture({
      alpha:
        "---\nname: alpha\ndescription: >-\n  How to change the vault model: add or change a kind.\n---\nPlain instructions.",
    });
    await expect(checkSkills(root)).resolves.toStrictEqual([]);
  });

  test("rejects malformed YAML, including an unquoted colon followed by a space", async () => {
    const root = fixture({
      malformed:
        "---\nname: malformed\ndescription: How to change: add a field\n---\n",
      broken: "---\nname: [unterminated\ndescription: x\n---\n",
    });
    const issues = (await checkSkills(root))
      .map(({ message }) => message)
      .join("\n");
    expect(issues.match(/invalid YAML frontmatter/gu)).toHaveLength(2);
  });

  test("reports directory name mismatch and blank or missing descriptions", async () => {
    const root = fixture({
      mismatch: "---\nname: other\ndescription: present\n---\n",
      blank: "---\nname: blank\ndescription: '  '\n---\n",
      missing: "---\nname: missing\n---\n",
    });
    const issues = (await checkSkills(root))
      .map(({ file, message }) => `${file}: ${message}`)
      .join("\n");
    expect(issues).toContain("name must match skill directory");
    expect(
      issues.match(/description must be a nonempty string/gu)
    ).toHaveLength(2);
  });

  test("reports a missing SKILL.md", async () => {
    const root = fixture({ absent: "<missing>" });
    expect((await checkSkills(root))[0]?.message).toBe("missing SKILL.md");
  });
});
