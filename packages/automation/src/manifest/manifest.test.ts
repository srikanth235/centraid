import { describe, expect, it } from "vitest";

import {
  ManifestError,
  isDeniedTriggerCursorEntity,
  isPendingWebhookTrigger,
  isValidCronExpression,
  isValidIanaTimeZone,
  parseManifest,
  validateManifest,
} from "./manifest.js";
import type { Manifest } from "./manifest.js";

/** A minimal valid `automation.json` object. */
function baseManifest(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "Daily digest",
    version: "0.1.0",
    enabled: true,
    prompt: "Summarize my open PRs every morning",
    triggers: [{ kind: "cron", expr: "0 9 * * *" }],
    requires: {},
    history: { keep: { count: 50 } },
    generated: { by: "centraid-builder", at: "2026-05-22T00:00:00Z" },
    ...over,
  };
}

describe(isValidCronExpression, () => {
  it("accepts canonical 5-field expressions", () => {
    expect(isValidCronExpression("*/30 * * * *")).toBe(true);
    expect(isValidCronExpression("0 9 * * MON-FRI")).toBe(true);
    expect(isValidCronExpression("15,45 * * * *")).toBe(true);
  });

  it("rejects empty / non-5-field / illegal-char expressions", () => {
    expect(isValidCronExpression("")).toBe(false);
    expect(isValidCronExpression("* * * *")).toBe(false);
    expect(isValidCronExpression("* * * * * *")).toBe(false);
    expect(isValidCronExpression("@hourly")).toBe(false);
    expect(isValidCronExpression("rm -rf / * * * *")).toBe(false);
  });
});

describe(isValidIanaTimeZone, () => {
  it("accepts known zones and rejects unknown ones", () => {
    expect(isValidIanaTimeZone("UTC")).toBe(true);
    expect(isValidIanaTimeZone("America/New_York")).toBe(true);
    expect(isValidIanaTimeZone("Not/A_Real_Zone")).toBe(false);
    expect(isValidIanaTimeZone("")).toBe(false);
  });
});

describe(validateManifest, () => {
  it("accepts a minimal valid manifest", () => {
    const m = validateManifest(baseManifest());
    expect(m.name).toBe("Daily digest");
    expect(m.version).toBe("0.1.0");
    expect(m.enabled).toBe(true);
    expect(m.triggers).toHaveLength(1);
    expect(m.triggers[0]).toStrictEqual({ kind: "cron", expr: "0 9 * * *" });
  });

  it("reads a plural triggers list with multiple crons", () => {
    const raw = baseManifest();
    raw.triggers = [
      { kind: "cron", expr: "0 9 * * *" },
      { kind: "cron", expr: "0 17 * * *" },
    ];
    const m = validateManifest(raw);
    expect(m.triggers).toHaveLength(2);
  });

  it("accepts an optional IANA tz on a cron trigger", () => {
    const raw = baseManifest();
    raw.triggers = [
      { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" },
    ];
    const m = validateManifest(raw);
    expect(m.triggers[0]).toStrictEqual({
      kind: "cron",
      expr: "0 9 * * *",
      tz: "America/New_York",
    });
  });

  it("rejects an unknown IANA tz at validation (not at fire time)", () => {
    const raw = baseManifest();
    raw.triggers = [{ kind: "cron", expr: "0 9 * * *", tz: "Not/A_Real_Zone" }];
    expect(() => validateManifest(raw)).toThrow(ManifestError);
    expect(() => validateManifest(raw)).toThrow(/not a known IANA timezone/u);
  });

  it("rejects an empty tz string", () => {
    const raw = baseManifest();
    raw.triggers = [{ kind: "cron", expr: "0 9 * * *", tz: "   " }];
    expect(() => validateManifest(raw)).toThrow(/non-empty IANA timezone/u);
  });

  it("accepts a webhook trigger with an id + secret hash", () => {
    const raw = baseManifest();
    raw.triggers = [{ kind: "webhook", id: "abc123", secretHash: "deadbeef" }];
    const m = validateManifest(raw);
    expect(m.triggers[0]?.kind).toBe("webhook");
  });

  it("accepts a pending webhook trigger (un-provisioned)", () => {
    const raw = baseManifest();
    raw.triggers = [{ kind: "webhook", pending: true }];
    const m = validateManifest(raw);
    expect(m.triggers[0]?.kind).toBe("webhook");
    expect(isPendingWebhookTrigger(m.triggers[0]!)).toBe(true);
  });

  it("rejects a webhook trigger that is neither provisioned nor pending", () => {
    const raw = baseManifest();
    raw.triggers = [{ kind: "webhook" }];
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("treats an empty triggers list as legal (manual fire only)", () => {
    const raw = baseManifest();
    raw.triggers = [];
    expect(validateManifest(raw).triggers).toStrictEqual([]);
  });

  it("rejects more than one webhook trigger", () => {
    const raw = baseManifest();
    raw.triggers = [
      { kind: "webhook", id: "a", secretHash: "h1" },
      { kind: "webhook", id: "b", secretHash: "h2" },
    ];
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("defaults version to 0.1.0 and enabled to true when absent", () => {
    const raw = baseManifest();
    delete raw.version;
    delete raw.enabled;
    const m = validateManifest(raw);
    expect(m.version).toBe("0.1.0");
    expect(m.enabled).toBe(true);
  });

  it("treats a non-true enabled as disabled", () => {
    expect(validateManifest(baseManifest({ enabled: false })).enabled).toBe(
      false
    );
  });

  it("carries the apps association list", () => {
    const m = validateManifest(baseManifest({ apps: ["todos", "habits"] }));
    expect(m.apps).toStrictEqual(["todos", "habits"]);
  });

  it("rejects a missing name", () => {
    const raw = baseManifest();
    delete raw.name;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("rejects a missing prompt", () => {
    const raw = baseManifest();
    delete raw.prompt;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("rejects a missing generated block", () => {
    const raw = baseManifest();
    delete raw.generated;
    expect(() => validateManifest(raw)).toThrow(ManifestError);
  });

  it("rejects an invalid trigger", () => {
    expect(() =>
      validateManifest(baseManifest({ triggers: [{ kind: "webhook" }] }))
    ).toThrow(ManifestError);
    expect(() =>
      validateManifest(
        baseManifest({ triggers: [{ kind: "cron", expr: "nope" }] })
      )
    ).toThrow(ManifestError);
  });

  it("rejects apps that is not an array of non-empty strings", () => {
    expect(() => validateManifest(baseManifest({ apps: "todos" }))).toThrow(
      ManifestError
    );
    expect(() => validateManifest(baseManifest({ apps: [""] }))).toThrow(
      ManifestError
    );
  });

  it("rejects a requires.model pointing at the mock provider", () => {
    expect(() =>
      validateManifest(
        baseManifest({ requires: { model: "centraid-mock/run" } })
      )
    ).toThrow(ManifestError);
  });

  it("round-trips an open runner key and rejects only empty/non-string values", () => {
    expect(
      validateManifest(
        baseManifest({ requires: { runner: "future-registry-runner" } })
      ).requires.runner
    ).toBe("future-registry-runner");
    expect(() =>
      validateManifest(baseManifest({ requires: { runner: "" } }))
    ).toThrow(/requires\.runner must be a non-empty string/u);
    expect(() =>
      validateManifest(baseManifest({ requires: { runner: 42 } }))
    ).toThrow(/requires\.runner must be a non-empty string/u);
  });

  it("round-trips an open thought-level pin and rejects empty values", () => {
    expect(
      validateManifest(
        baseManifest({ requires: { thoughtLevel: "vendor-ultra" } })
      ).requires.thoughtLevel
    ).toBe("vendor-ultra");
    expect(() =>
      validateManifest(baseManifest({ requires: { thoughtLevel: "" } }))
    ).toThrow(/requires\.thoughtLevel must be a non-empty string/u);
  });

  it("defaults history.keep to {count:100} when history is absent", () => {
    const raw = baseManifest();
    delete raw.history;
    const m: Manifest = validateManifest(raw);
    expect(m.history.keep).toStrictEqual({ count: 100 });
  });
});

describe(parseManifest, () => {
  it("round-trips a JSON string", () => {
    const m = parseManifest(JSON.stringify(baseManifest()));
    expect(m.name).toBe("Daily digest");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{not json")).toThrow(ManifestError);
  });
});

describe("condition triggers", () => {
  const base = {
    name: "Chaser",
    prompt: "chase what is due",
    generated: { by: "test", at: "2026-07-03" },
    vault: {
      purpose: "dpv:Billing",
      scopes: [{ schema: "business", verbs: "read" }],
    },
  };

  it("accepts entity + where + every and preserves trigger order", () => {
    const m = validateManifest({
      ...base,
      triggers: [
        { kind: "cron", expr: "0 9 * * *" },
        {
          kind: "condition",
          entity: "business.invoice",
          where: [
            { column: "status", op: "eq", value: "sent" },
            { column: "due_at", op: "within-next-days", value: 3 },
          ],
          every: "*/10 * * * *",
        },
      ],
    });
    expect(m.triggers[1]).toStrictEqual({
      kind: "condition",
      entity: "business.invoice",
      where: [
        { column: "status", op: "eq", value: "sent" },
        { column: "due_at", op: "within-next-days", value: 3 },
      ],
      every: "*/10 * * * *",
    });
  });

  it("requires a vault block — the read needs a grant to run under", () => {
    expect(() =>
      validateManifest({
        name: "x",
        prompt: "y",
        generated: { by: "t", at: "now" },
        triggers: [{ kind: "condition", entity: "business.invoice" }],
      })
    ).toThrow(/vault block/u);
  });

  it("rejects malformed entities, ops and gates", () => {
    expect(() =>
      validateManifest({
        ...base,
        triggers: [{ kind: "condition", entity: "invoice" }],
      })
    ).toThrow(/schema.*table|entity/u);
    expect(() =>
      validateManifest({
        ...base,
        triggers: [
          {
            kind: "condition",
            entity: "business.invoice",
            where: [{ column: "status", op: "like", value: "%x%" }],
          },
        ],
      })
    ).toThrow(/op/u);
    expect(() =>
      validateManifest({
        ...base,
        triggers: [
          { kind: "condition", entity: "business.invoice", every: "often" },
        ],
      })
    ).toThrow(/cron/u);
  });
});

describe("data triggers", () => {
  const base = {
    name: "Reconciler",
    prompt: "match credits to invoices",
    generated: { by: "test", at: "2026-07-03" },
    vault: {
      purpose: "dpv:Billing",
      scopes: [{ schema: "core", table: "transaction", verbs: "read" }],
    },
  };

  it("accepts entities + every", () => {
    const m = validateManifest({
      ...base,
      triggers: [
        { kind: "data", entities: ["core.transaction"], every: "*/2 * * * *" },
      ],
    });
    expect(m.triggers[0]).toStrictEqual({
      kind: "data",
      entities: ["core.transaction"],
      every: "*/2 * * * *",
    });
  });

  it("requires a vault block and well-formed entity names", () => {
    expect(() =>
      validateManifest({
        name: "x",
        prompt: "y",
        generated: { by: "t", at: "now" },
        triggers: [{ kind: "data", entities: ["core.transaction"] }],
      })
    ).toThrow(/vault block/u);
    expect(() =>
      validateManifest({ ...base, triggers: [{ kind: "data", entities: [] }] })
    ).toThrow(/entities/u);
    expect(() =>
      validateManifest({
        ...base,
        triggers: [{ kind: "data", entities: ["transactions"] }],
      })
    ).toThrow(/entity name/u);
  });

  it("refuses outbox entities — a drain receipt must not re-fire the stager (issue #308 A8)", () => {
    expect(() =>
      validateManifest({
        ...base,
        triggers: [{ kind: "data", entities: ["outbox.item"] }],
      })
    ).toThrow(/outbox/u);
    expect(() =>
      validateManifest({
        ...base,
        triggers: [
          { kind: "data", entities: ["core.transaction", "outbox.grant"] },
        ],
      })
    ).toThrow(/outbox/u);
  });
});

describe("provider event triggers and cursor loop guard", () => {
  const base = {
    name: "Inbox watcher",
    prompt: "summarize new activity",
    generated: { by: "test", at: "2026-07-25" },
    connections: [
      {
        connectionId: "connection-1",
        kind: "pull.gmail",
        label: "Personal Gmail",
      },
    ],
  };

  it("accepts a supported event only when that connector kind is bound", () => {
    expect(
      validateManifest({
        ...base,
        triggers: [
          {
            kind: "event",
            connectorKind: "pull.gmail",
            event: "new-message",
            every: "*/2 * * * *",
          },
        ],
      }).triggers[0]
    ).toStrictEqual({
      kind: "event",
      connectorKind: "pull.gmail",
      event: "new-message",
      every: "*/2 * * * *",
    });
    expect(() =>
      validateManifest({
        ...base,
        connections: [],
        triggers: [
          { kind: "event", connectorKind: "pull.gmail", event: "new-message" },
        ],
      })
    ).toThrow(/bound.*pull\.gmail/iu);
    expect(() =>
      validateManifest({
        ...base,
        triggers: [
          { kind: "event", connectorKind: "pull.gmail", event: "mail-deleted" },
        ],
      })
    ).toThrow(/unsupported provider event/u);
  });

  it.each([
    "trigger_ingress",
    "automation_trigger_cursor",
    "automation_state",
    "scheduler_ledger",
    "conversations",
    "turns",
    "items",
    "attachments",
    "run_summary",
    "conversation_archive",
    "conversation_digest",
  ])(
    "denies the bare runtime ledger table %s at the cursor guard",
    (entity) => {
      expect(isDeniedTriggerCursorEntity(entity)).toBe(true);
      // A user's own vault table that merely ends in the same word is data.
      expect(isDeniedTriggerCursorEntity(`shop.${entity}`)).toBe(false);
    }
  );

  it.each(["outbox.item", "outbox.receipt"])(
    "rejects loop-sensitive condition/data cursor entity %s",
    (entity) => {
      const vault = {
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "core", table: "event", verbs: "read" }],
      };
      expect(() =>
        validateManifest({
          name: "Loop",
          prompt: "never loop",
          generated: { by: "test", at: "2026-07-25" },
          vault,
          triggers: [{ kind: "condition", entity }],
        })
      ).toThrow(/prevent trigger loops/u);
      expect(() =>
        validateManifest({
          name: "Loop",
          prompt: "never loop",
          generated: { by: "test", at: "2026-07-25" },
          vault,
          triggers: [{ kind: "data", entities: [entity] }],
        })
      ).toThrow(/prevent trigger loops/u);
    }
  );

  it.each([
    "inventory.items",
    "shop.attachments",
    "crm.conversations",
    "schedule.turns",
  ])(
    "accepts the user vault entity %s — the loop guard names runtime tables, not table words",
    (entity) => {
      const vault = {
        purpose: "dpv:ServiceProvision",
        scopes: [{ schema: "core", table: "event", verbs: "read" }],
      };
      expect(
        validateManifest({
          name: "Watch",
          prompt: "watch my own data",
          generated: { by: "test", at: "2026-07-25" },
          vault,
          triggers: [{ kind: "condition", entity }],
        }).triggers[0]
      ).toMatchObject({ kind: "condition", entity });
      expect(
        validateManifest({
          name: "Watch",
          prompt: "watch my own data",
          generated: { by: "test", at: "2026-07-25" },
          vault,
          triggers: [{ kind: "data", entities: [entity] }],
        }).triggers[0]
      ).toMatchObject({ kind: "data", entities: [entity] });
    }
  );
});
