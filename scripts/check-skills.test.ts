import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSkills } from "./check-skills";

const roots: string[] = [];
function fixture(skills: Record<string, string>): string {
  // UUID names provide isolated fixtures; afterEach removes each owned tree.
  const root = path.join(tmpdir(), `skill-check-${randomUUID()}`);
  mkdirSync(root);
  roots.push(root);
  for (const [name, body] of Object.entries(skills)) {
    const directory = path.join(root, ".claude", "skills", name);
    mkdirSync(directory, { recursive: true });
    if (body !== "<missing>")
      writeFileSync(path.join(directory, "SKILL.md"), body);
  }
  return root;
}

// oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- Bun's YAML parser is only available under bun:test.
afterEach(async () => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("accepts block YAML containing the vault description's colon followed by a space", async () => {
  const root = fixture({
    alpha:
      "---\nname: alpha\ndescription: >-\n  How to change the vault model: add or change a kind.\n---\nPlain instructions.",
  });
  expect(await checkSkills(root)).toEqual([]);
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
  expect(issues.match(/description must be a nonempty string/gu)).toHaveLength(
    2
  );
});

test("reports a missing SKILL.md", async () => {
  const root = fixture({ absent: "<missing>" });
  expect((await checkSkills(root))[0]?.message).toBe("missing SKILL.md");
});
