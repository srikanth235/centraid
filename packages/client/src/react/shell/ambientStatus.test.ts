import { describe, expect, it } from "vitest";

import { ambientStatusFor } from "./ambientStatus.js";
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
