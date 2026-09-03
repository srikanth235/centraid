import { describe, expect, it, vi } from "vitest";

import { vaultForTriggers } from "./AutomationEditorRoute.js";

vi.mock(import("../../../gateway-client.js"), () => ({}));
vi.mock(import("../../../assist-oauth-handoff.js"), () => ({}));

describe(vaultForTriggers, () => {
  it("returns undefined when no data/condition trigger contributes an entity", () => {
    expect(
      vaultForTriggers([{ kind: "cron", expr: "0 9 * * *" }])
    ).toBeUndefined();
    expect(vaultForTriggers([{ kind: "webhook" }])).toBeUndefined();
    expect(vaultForTriggers([])).toBeUndefined();
  });

  it("derives read scopes from condition + data triggers, splitting schema.table", () => {
    const vault = vaultForTriggers([
      { kind: "condition", entity: "schedule.task" },
      { kind: "data", entities: ["core.transaction", "core.party"] },
    ]);
    expect(vault).toStrictEqual({
      purpose: "dpv:ServiceProvision",
      why: "Evaluate automation triggers.",
      scopes: [
        { schema: "schedule", table: "task", verbs: "read" },
        { schema: "core", table: "transaction", verbs: "read" },
        { schema: "core", table: "party", verbs: "read" },
      ],
    });
  });

  it("maps a bare (dotless) entity to a schema-only scope with no table", () => {
    expect(
      vaultForTriggers([{ kind: "condition", entity: "notifications" }])
    ).toStrictEqual({
      purpose: "dpv:ServiceProvision",
      why: "Evaluate automation triggers.",
      scopes: [{ schema: "notifications", verbs: "read" }],
    });
  });

  it("de-duplicates entities shared across triggers", () => {
    const vault = vaultForTriggers([
      { kind: "data", entities: ["core.event"] },
      { kind: "condition", entity: "core.event" },
    ]);
    expect(vault?.scopes).toStrictEqual([
      { schema: "core", table: "event", verbs: "read" },
    ]);
  });
});
