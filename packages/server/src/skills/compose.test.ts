import { describe, expect, test } from "vitest";

import {
  listSkills,
  composeSkills,
  parseSkillFile,
  skillsDir,
} from "./compose.js";

describe("compose", () => {
  test("skillsDir resolves to an existing catalog with the authoring skill", () => {
    // One skill (#799): app front ends are not harness-authored, so the
    // catalog ships no app-authoring skill.
    const skills = listSkills(skillsDir());
    const names = skills.map((s) => s.name).sort();
    expect(names).toStrictEqual(["automation-authoring"]);
    for (const s of skills) {
      expect(s.description.length > 0).toBeTruthy();
    }
  });

  test("parseSkillFile strips YAML frontmatter and returns the body", () => {
    const { meta, body } = parseSkillFile(
      "---\nname: foo\ndescription: bar baz\n---\n# Heading\n\ntext"
    );
    expect(meta.name).toBe("foo");
    expect(meta.description).toBe("bar baz");
    expect(body).toBe("# Heading\n\ntext");
  });

  test("composeSkills returns the authoring contract body, frontmatter removed", () => {
    const composed = composeSkills(["automation-authoring"]);
    expect(
      composed.startsWith("## Centraid automation authoring")
    ).toBeTruthy();
    expect(!composed.includes("---\nname:")).toBeTruthy();
  });

  test("composeSkills joins the named skills with a blank line", () => {
    const composed = composeSkills([
      "automation-authoring",
      "automation-authoring",
    ]);
    const first = composeSkills(["automation-authoring"]);
    expect(composed).toBe(`${first}\n\n${first}`);
  });
});
