import { describe, expect, it } from "vitest";

import { ambientSignalFor, ambientStatusFor } from "./ambientStatus.js";
import { OFFLINE_COMMIT_REASON } from "./commitAvailability.js";

const quiet = { blockingCount: 0, hasUnreadNotices: false };

describe("shell/ambientStatus", () => {
  it("says Synced only when the gateway actually answered", () => {
    expect(ambientStatusFor({ ...quiet, gatewayStatus: "up" })).toBe("Synced");
  });

  it("says the offline sentence when the gateway is known to be down", () => {
    // The bug this replaces: "down" and "unknown" both mapped to "Ready", so
    // the line made an affirmative claim while the gateway was stopped.
    expect(ambientStatusFor({ ...quiet, gatewayStatus: "down" })).toBe(
      OFFLINE_COMMIT_REASON
    );
  });

  it("says it is still checking while the verdict is unknown", () => {
    // On the web host that window is ~31s (three Iroh dials at a 15s timeout
    // with backoff) — far too long to be calling it "Ready".
    expect(ambientStatusFor({ ...quiet, gatewayStatus: "unknown" })).toBe(
      "Checking…"
    );
    expect(ambientStatusFor({ ...quiet, gatewayStatus: undefined })).toBe(
      "Checking…"
    );
  });

  it("puts work waiting on the member ahead of reachability", () => {
    expect(
      ambientStatusFor({
        blockingCount: 1,
        hasUnreadNotices: true,
        gatewayStatus: "down",
      })
    ).toBe("1 decision waiting on you");
    expect(
      ambientStatusFor({
        blockingCount: 2,
        hasUnreadNotices: false,
        gatewayStatus: "up",
      })
    ).toBe("2 decisions waiting on you");
    expect(
      ambientStatusFor({
        blockingCount: 0,
        hasUnreadNotices: true,
        gatewayStatus: "unknown",
      })
    ).toBe("New notices to read");
  });
});

describe("shell/ambientSignal", () => {
  const now = Date.UTC(2026, 7, 14, 9, 30);

  it("keeps healthy custodian state quiet and grounded in live facts", () => {
    expect(
      ambientSignalFor({
        deviceCount: 3,
        gatewayStatus: "up",
        lastBackupAt: now - 25 * 60_000,
        now,
        seat: "custodian",
      })
    ).toStrictEqual({
      copy: "All safe · backed up 25 min ago · 3 devices in sync",
      tone: "quiet",
    });
  });

  it("makes an overdue custodian backup actionable but a viewer read-only", () => {
    const facts = {
      gatewayStatus: "up" as const,
      lastBackupAt: now - 2 * 86_400_000,
      now,
    };
    expect(ambientSignalFor({ ...facts, seat: "custodian" })).toMatchObject({
      action: {
        label: "Back up now",
        route: {
          kind: "gateway",
          focus: "backups",
          cause: "backup-alert",
        },
      },
      tone: "attention",
    });
    expect(ambientSignalFor({ ...facts, seat: "viewer" })).toStrictEqual({
      copy: "Backup overdue by 2 days",
      tone: "attention",
    });
  });

  it("puts the seat's danger first when the gateway is unreachable", () => {
    expect(
      ambientSignalFor({
        gatewayStatus: "down",
        now,
        onlyHereCount: 2,
        seat: "origin",
      })
    ).toMatchObject({
      copy: "Can’t reach your vault · 2 items exist only here",
      action: { route: { kind: "approvals" } },
      tone: "urgent",
    });
    expect(
      ambientSignalFor({
        gatewayDownSince: now - 2 * 60_000,
        gatewayStatus: "down",
        now,
        seat: "custodian",
      }).copy
    ).toBe("Vault host unavailable since 2 min");
  });
});
