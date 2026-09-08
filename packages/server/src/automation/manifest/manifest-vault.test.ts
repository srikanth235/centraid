import { describe, expect, it } from "vitest";

import { validateManifest } from "./manifest.js";

describe("manifest vault block", () => {
  const base = {
    name: "Briefing",
    prompt: "summarize the day",
    generated: { by: "test", at: "2026-07-03" },
  };

  it("accepts a scopes request and round-trips it", () => {
    const m = validateManifest({
      ...base,
      vault: {
        why: "reads your agenda",
        scopes: [
          { schema: "schedule", verbs: "read" },
          { schema: "schedule", table: "add_task", verbs: "act" },
        ],
      },
    });
    expect(m.vault).toStrictEqual({
      why: "reads your agenda",
      scopes: [
        { schema: "schedule", verbs: "read" },
        { schema: "schedule", table: "add_task", verbs: "act" },
      ],
    });
  });

  it("is optional — a manifest without it has no vault surface request", () => {
    expect(validateManifest(base).vault).toBeUndefined();
  });

  it("accepts row and field minimized scopes for trusted anchors", () => {
    expect(
      validateManifest({
        ...base,
        vault: {
          scopes: [
            {
              schema: "schedule",
              table: "task",
              verbs: "read",
              rowFilter: [{ column: "task_id", op: "eq", value: "task-1" }],
              fieldMask: ["task_id", "title"],
            },
          ],
        },
      }).vault?.scopes[0]
    ).toStrictEqual({
      schema: "schedule",
      table: "task",
      verbs: "read",
      rowFilter: [{ column: "task_id", op: "eq", value: "task-1" }],
      fieldMask: ["task_id", "title"],
    });
  });

  it("rejects malformed and unsupported scopes", () => {
    expect(() =>
      validateManifest({
        ...base,
        vault: { scopes: [] },
      })
    ).toThrow(/vault\.scopes/u);
    expect(() =>
      validateManifest({
        ...base,
        vault: {
          scopes: [{ schema: "tally", verbs: "write" }],
        },
      })
    ).toThrow(/verbs/u);
    expect(() =>
      validateManifest({
        ...base,
        vault: {
          scopes: [
            {
              schema: "schedule",
              table: "task",
              verbs: "read",
              rowFilter: [],
              fieldMask: ["title", "title"],
            },
          ],
        },
      })
    ).toThrow(/rowFilter/u);
    expect(() =>
      validateManifest({
        ...base,
        vault: {
          scopes: [
            {
              schema: "schedule",
              table: "task",
              verbs: "read",
              rowFilter: [
                { column: "task_id", op: "contains", value: "task-1" },
              ],
            },
          ],
        },
      })
    ).toThrow(/supported vault filter operator/u);
  });
});
