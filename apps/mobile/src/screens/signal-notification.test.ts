import { describe, expect, it } from "vitest";

import { signalNotificationCopy } from "./signal-notification";

describe(signalNotificationCopy, () => {
  it("carries the upload failure cause and points to phone detail", () => {
    const copy = signalNotificationCopy(
      "Can't reach your vault · 2 videos only on this phone",
      "phone"
    );
    expect(copy.cause).toContain("Can't reach your vault");
    expect(copy).toMatchObject({
      actionLabel: "Open On this phone",
      detail: "phone",
      destination: "PhoneStorage",
      destinationParams: {
        signalCause: "Can't reach your vault · 2 videos only on this phone",
      },
    });
  });

  it("points backup causes to Backup health", () => {
    expect(
      signalNotificationCopy("3 items have no verified backup", "backup")
    ).toMatchObject({
      actionLabel: "Open Backup health",
      destination: "BackupHealth",
      destinationParams: { signalCause: "3 items have no verified backup" },
      detail: "backup",
    });
  });
});
