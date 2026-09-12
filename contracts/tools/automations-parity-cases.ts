// THE CASE TABLES for the automations parity bundle (#1020, wave 4 lane
// automations).
//
// Split out of `export-automations-parity.ts` at the repository's 625-line
// ceiling, on the same line Photos' generator is split: this half is WHAT is
// asked — the zones, the expressions, the windows, the manifest documents and
// the gate grid — and that file is the build and the write.

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..", "..");

/** v0's `readCronCursor`, as this file calls it. */
export type ReadCronCursor = (
  schedules: readonly unknown[],
  cursor: { positionJson?: string } | undefined,
  at: Date
) => {
  elements: { position: string; occurredAt: number }[];
  positionJson?: string;
  skipped?: number;
  gapReason?: string;
};

export interface CronCase {
  expr: string;
  zone: string;
  instant: string;
  matches: boolean;
}

export interface WindowCase {
  name: string;
  schedules: { expr: string; timeZone: string; backfill: string }[];
  from: string;
  to: string;
  delivered: string[];
  skipped: number;
  gapReason?: string;
}

/**
 * THE PINNED TRANSITIONS (`docs/cron-timezone.md` DST policy), plus two zones
 * whose arithmetic has broken before: a half-hour offset and a negative-DST
 * southern-hemisphere zone.
 */
const ZONES = [
  "UTC",
  "America/New_York",
  "Asia/Kolkata",
  "Australia/Lord_Howe",
  "Pacific/Chatham",
] as const;

/** Every field form v0's matcher accepts, and three it must refuse. */
const EXPRESSIONS = [
  "* * * * *",
  "0 * * * *",
  "0 7 * * *",
  "30 1 * * *",
  "30 2 * * *",
  "*/15 * * * *",
  "0 0-6 * * *",
  "0 0 1,15 * *",
  "0 0 1 * 1",
  "0 0 * * 0",
  "0 0 * * 7",
  "0 9 29 2 *",
  "*/5 9-17 * * 1-5",
  "x * * * *",
  "*/0 * * * *",
  "* * * *",
] as const;

/** One instant every 37 minutes across three pinned days, in each zone. */
function instants(): string[] {
  const days = [
    // Spring forward and fall back in America/New_York.
    Date.UTC(2026, 2, 8, 4, 0),
    Date.UTC(2026, 10, 1, 3, 0),
    // An ordinary Thursday, so the weekday forms have a case.
    Date.UTC(2026, 0, 1, 0, 0),
  ];
  const out: string[] = [];
  for (const day of days) {
    for (let minute = 0; minute < 26 * 60; minute += 37) {
      out.push(new Date(day + minute * 60_000).toISOString());
    }
  }
  return out;
}

export function cronCases(
  cronMatches: (expr: string, date: Date, tz?: string) => boolean
) {
  const cases: CronCase[] = [];
  for (const zone of ZONES) {
    for (const expr of EXPRESSIONS) {
      for (const instant of instants()) {
        cases.push({
          expr,
          zone,
          instant,
          matches: cronMatches(expr, new Date(instant), zone),
        });
      }
    }
  }
  return cases;
}

/**
 * THE FINDING, as a fixture row (R-1020-35).
 *
 * v0's third tier reads the HOST clock. This generator runs on a UTC host, so
 * `cronMatches("0 7 * * *", 01:30Z)` with no zone answers `false` — the
 * schedule fires at 07:00 UTC, which for a member in Asia/Kolkata is half past
 * twelve. The same call WITH the vault's zone answers `true`. Both are
 * recorded; the Rust port has no third tier and answers the second.
 *
 * NOT FIXED IN v0, deliberately: tier 3 is the "keeps firing at the same
 * wall-clock minute" promise on a laptop, and it is wrong only on a VPS, which
 * v0 does not ship to. A finding, not a fix.
 */
export function utcHostCase(
  cronMatches: (expr: string, date: Date, tz?: string) => boolean
) {
  // 2026-03-09T01:30:00Z is 07:00 in Asia/Kolkata.
  const instant = new Date(Date.UTC(2026, 2, 9, 1, 30));
  return {
    name: "utc-host-third-tier",
    expr: "0 7 * * *",
    instant: instant.toISOString(),
    vaultZone: "Asia/Kolkata",
    hostZone: process.env.TZ ?? "UTC",
    withVaultZone: cronMatches("0 7 * * *", instant, "Asia/Kolkata"),
    withNoZone: cronMatches("0 7 * * *", instant),
    note:
      "v0's third resolution tier is the host clock. On a UTC VPS the answer " +
      "with no zone is the wrong one for every member outside UTC. The Rust " +
      "port deletes tier 3 and answers withVaultZone; this row is the finding.",
  };
}

export function cronWindows(read: ReadCronCursor) {
  const base = Date.UTC(2026, 0, 1, 0, 0);
  const cases: {
    name: string;
    schedules: WindowCase["schedules"];
    from: number;
    to: number;
  }[] = [
    {
      name: "latest-collapses-a-catch-up",
      schedules: [{ expr: "0 * * * *", timeZone: "UTC", backfill: "latest" }],
      from: base + 8 * 3_600_000,
      to: base + 10 * 3_600_000 + 30 * 60_000,
    },
    {
      name: "each-delivers-every-missed-occurrence",
      schedules: [{ expr: "0 * * * *", timeZone: "UTC", backfill: "each" }],
      from: base,
      to: base + 5 * 3_600_000,
    },
    {
      name: "each-is-bounded-and-the-remainder-is-a-gap",
      schedules: [{ expr: "0 * * * *", timeZone: "UTC", backfill: "each" }],
      from: base,
      to: base + 40 * 3_600_000,
    },
    {
      name: "two-schedules-one-minute-one-fire",
      schedules: [
        { expr: "0 9 * * *", timeZone: "UTC", backfill: "latest" },
        { expr: "0 9 * * 1-5", timeZone: "UTC", backfill: "latest" },
      ],
      from: base,
      to: base + 24 * 3_600_000,
    },
    {
      name: "a-fall-back-wall-minute-fires-once",
      schedules: [
        {
          expr: "30 1 * * *",
          timeZone: "America/New_York",
          backfill: "latest",
        },
      ],
      from: Date.UTC(2026, 10, 1, 4, 0),
      to: Date.UTC(2026, 10, 1, 10, 0),
    },
    {
      name: "a-spring-forward-wall-minute-never-fires",
      schedules: [
        { expr: "30 2 * * *", timeZone: "America/New_York", backfill: "each" },
      ],
      from: Date.UTC(2026, 2, 8, 5, 0),
      to: Date.UTC(2026, 2, 9, 4, 0),
    },
    {
      name: "a-half-hour-zone-fires-at-its-own-wall-clock",
      schedules: [
        { expr: "0 7 * * *", timeZone: "Asia/Kolkata", backfill: "each" },
      ],
      from: base,
      to: base + 3 * 86_400_000,
    },
    {
      name: "a-southern-hemisphere-zone-fires-once-a-day",
      schedules: [
        {
          expr: "0 7 * * *",
          timeZone: "Australia/Lord_Howe",
          backfill: "each",
        },
      ],
      from: base,
      to: base + 3 * 86_400_000,
    },
  ];
  return cases.map((entry): WindowCase => {
    const result = read(
      entry.schedules,
      { positionJson: JSON.stringify(entry.from) },
      new Date(entry.to)
    );
    return {
      name: entry.name,
      schedules: entry.schedules,
      from: new Date(entry.from).toISOString(),
      to: new Date(entry.to).toISOString(),
      delivered: result.elements.map((element) =>
        new Date(element.occurredAt).toISOString()
      ),
      skipped: result.skipped ?? 0,
      ...(result.gapReason === undefined
        ? {}
        : { gapReason: result.gapReason }),
    };
  });
}

/**
 * The manifest documents, and what v0's parser answers for each.
 *
 * EVERY DOCUMENT IS LEGAL IN EVERY RESPECT BUT THE ONE IT TESTS. v0 requires
 * `name`, `prompt` and a `generated` block, a `vault` block behind any
 * condition or data trigger, and a bound connection behind any event trigger —
 * so a case that omitted those would be refused for the wrong reason and the
 * fixture would prove nothing about the guard it is named after. That is the
 * mistake this generator caught in the port's own parser.
 */
const GENERATED = { by: "builder", at: "2026-01-01T00:00:00.000Z" } as const;
const VAULT_BLOCK = {
  why: "to reconcile",
  scopes: [{ schema: "core", verbs: "read" }],
} as const;

function baseDocument(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "Morning digest",
    prompt: "summarise yesterday",
    generated: GENERATED,
    ...extra,
  };
}

const MANIFESTS: { name: string; document: unknown }[] = [
  {
    name: "the-five-kinds",
    document: baseDocument({
      triggers: [
        {
          kind: "cron",
          expr: "0 7 * * *",
          tz: "Asia/Kolkata",
          backfill: "each",
        },
        { kind: "webhook", pending: true },
        {
          kind: "condition",
          entity: "core.transaction",
          where: [{ column: "amount", op: "gt", value: 100 }],
        },
        { kind: "data", entities: ["core.document"], every: "*/2 * * * *" },
        { kind: "event", connectorKind: "pull.gmail", event: "new-message" },
      ],
      vault: VAULT_BLOCK,
      connections: [{ connectionId: "c1", kind: "pull.gmail", label: "Inbox" }],
    }),
  },
  {
    name: "a-minted-webhook",
    document: baseDocument({
      triggers: [{ kind: "webhook", id: "abc123", secretHash: "a".repeat(64) }],
    }),
  },
  {
    name: "a-half-minted-webhook",
    document: baseDocument({ triggers: [{ kind: "webhook", id: "abc123" }] }),
  },
  {
    name: "two-webhooks",
    document: baseDocument({
      triggers: [
        { kind: "webhook", pending: true },
        { kind: "webhook", pending: true },
      ],
    }),
  },
  {
    name: "an-unknown-zone",
    document: baseDocument({
      triggers: [{ kind: "cron", expr: "0 7 * * *", tz: "Mars/Olympus" }],
    }),
  },
  {
    name: "an-invalid-expression",
    document: baseDocument({ triggers: [{ kind: "cron", expr: "hourly" }] }),
  },
  {
    name: "an-unknown-backfill-class",
    document: baseDocument({
      triggers: [{ kind: "cron", expr: "0 7 * * *", backfill: "all" }],
    }),
  },
  {
    name: "a-data-trigger-on-the-cursor-table",
    document: baseDocument({
      triggers: [{ kind: "data", entities: ["automation_trigger_cursor"] }],
      vault: VAULT_BLOCK,
    }),
  },
  {
    name: "a-data-trigger-on-the-outbox",
    document: baseDocument({
      triggers: [{ kind: "data", entities: ["outbox.item"] }],
      vault: VAULT_BLOCK,
    }),
  },
  {
    name: "a-condition-trigger-on-the-ingress",
    document: baseDocument({
      triggers: [{ kind: "condition", entity: "trigger_ingress" }],
      vault: VAULT_BLOCK,
    }),
  },
  {
    name: "a-condition-trigger-with-no-vault-block",
    document: baseDocument({
      triggers: [{ kind: "condition", entity: "core.transaction" }],
    }),
  },
  {
    name: "an-event-trigger-with-no-bound-connection",
    document: baseDocument({
      triggers: [
        { kind: "event", connectorKind: "pull.gmail", event: "new-message" },
      ],
    }),
  },
  {
    name: "an-unsupported-provider-event",
    document: baseDocument({
      triggers: [
        {
          kind: "event",
          connectorKind: "pull.gmail",
          event: "deleted-message",
        },
      ],
      connections: [{ connectionId: "c1", kind: "pull.gmail", label: "Inbox" }],
    }),
  },
  {
    name: "the-system-sandbox-lane",
    document: baseDocument({ triggers: [], sandbox: { lane: "system" } }),
  },
  {
    name: "an-enricher-with-no-lane",
    document: baseDocument({
      triggers: [],
      enrich: { domain: "photos", capability: "faces" },
    }),
  },
  {
    name: "the-mock-provider",
    document: baseDocument({
      triggers: [],
      requires: { model: "centraid-mock/echo" },
    }),
  },
  {
    name: "secrets-without-a-connector",
    document: baseDocument({
      triggers: [],
      requires: { secrets: ["locker:@bank:password"] },
    }),
  },
  {
    name: "a-connector-with-no-vault-block",
    document: baseDocument({ triggers: [], connector: { kind: "pull.gmail" } }),
  },
  {
    name: "no-prompt",
    document: { name: "X", triggers: [], generated: GENERATED },
  },
  {
    name: "no-provenance",
    document: { name: "X", prompt: "do it", triggers: [] },
  },
  {
    name: "an-unknown-notify-class",
    document: baseDocument({ triggers: [], notify: "sometimes" }),
  },
  {
    name: "a-field-mask-with-no-table",
    document: baseDocument({
      triggers: [],
      vault: {
        scopes: [{ schema: "core", verbs: "read", fieldMask: ["title"] }],
      },
    }),
  },
  {
    name: "an-unknown-vault-verb",
    document: baseDocument({
      triggers: [],
      vault: { scopes: [{ schema: "core", verbs: "write" }] },
    }),
  },
];

export function manifests(parse: (text: string) => unknown) {
  return MANIFESTS.map((entry) => {
    try {
      const parsed = parse(JSON.stringify(entry.document)) as {
        triggers?: { kind: string }[];
        enrich?: { lane?: string };
        notify?: string;
        version?: string;
        enabled?: boolean;
      };
      return {
        name: entry.name,
        document: entry.document,
        outcome: "accepted" as const,
        kinds: (parsed.triggers ?? []).map((trigger) => trigger.kind),
        notify: parsed.notify ?? "",
        version: parsed.version ?? "",
        enabled: parsed.enabled === true,
        ...(parsed.enrich?.lane === undefined
          ? {}
          : { enrichLane: parsed.enrich.lane }),
      };
    } catch (error) {
      const failure = error as {
        code?: string;
        field?: string;
        message?: string;
      };
      return {
        name: entry.name,
        document: entry.document,
        outcome: "refused" as const,
        code: failure.code ?? "unknown",
        field: failure.field ?? "",
      };
    }
  });
}

/** The tier x lane grid, at both provenance answers, plus the unreadable case. */
export function gateGrid(
  decide: (input: unknown) => unknown,
  tiers: readonly string[],
  lanes: readonly string[]
) {
  const rows: unknown[] = [];
  for (const tier of [...tiers, undefined]) {
    for (const lane of lanes) {
      for (const system of [false, true]) {
        const decision = decide({
          automationRef: "faces/faces",
          domain: "photos",
          capability: "faces",
          lane,
          tier,
          system,
        }) as { allowed: boolean; sealModelTurns?: boolean };
        rows.push({
          tier: tier ?? null,
          lane,
          system,
          allowed: decision.allowed,
          ...(decision.allowed
            ? { sealModelTurns: decision.sealModelTurns === true }
            : {}),
        });
      }
    }
  }
  return rows;
}

/** The recipe catalogue, from the two constants and the weights manifest. */
export function recipeCatalogue(
  system: readonly string[],
  bundledOptional: readonly string[]
) {
  const lock = JSON.parse(
    readFileSync(
      path.join(ROOT, "packages/model-runtime/models.lock.json"),
      "utf8"
    )
  ) as {
    schemaVersion: number;
    files: {
      model: string;
      path: string;
      capabilities: string[];
      bytes: number;
      sha256: string;
    }[];
  };
  const byCapability = new Map<
    string,
    { bytes: number; models: Set<string> }
  >();
  for (const file of lock.files) {
    for (const capability of file.capabilities) {
      const entry = byCapability.get(capability) ?? {
        bytes: 0,
        models: new Set<string>(),
      };
      entry.bytes += file.bytes;
      entry.models.add(file.model);
      byCapability.set(capability, entry);
    }
  }
  return {
    schemaVersion: lock.schemaVersion,
    tiers: {
      system: [...system],
      "bundled-optional": [...bundledOptional],
    },
    reserved: [...system, ...bundledOptional].sort(),
    weights: [...byCapability.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([capability, entry]) => ({
        capability,
        bytes: entry.bytes,
        models: [...entry.models].sort(),
      })),
  };
}
