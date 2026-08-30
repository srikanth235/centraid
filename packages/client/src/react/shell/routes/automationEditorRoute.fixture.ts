export function automationRow(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest["triggers"] = [
    { kind: "webhook", id: "hook-1" },
    { kind: "cron", expr: "0 9 * * *" },
    { kind: "data", entities: ["schedule.task"], every: "5m" },
    {
      kind: "condition",
      entity: "schedule.task",
      every: "10m",
      where: [{ column: "status", op: "eq", value: "open" }],
    },
    {
      kind: "event",
      connectorKind: "github",
      event: "issues.opened",
      filter: { label: "bug" },
      every: "15m",
    },
  ];
  return {
    id: "daily",
    dir: "/apps/daily",
    name: "Daily",
    triggers,
    enabled: true,
    ownerApp: "daily",
    ref: "daily/daily",
    manifest: {
      name: "Daily",
      version: "0.1.0",
      enabled: true,
      prompt: "Run daily.",
      triggers,
      requires: {},
      history: { keep: { count: 10 } },
      generated: { by: "centraid-builder", at: "2026-07-25T00:00:00.000Z" },
    },
  };
}
