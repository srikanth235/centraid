// The shelf's one pending sentence (#880).
import { describe, expect, it } from "vitest";

import type { PendingChange } from "../../kit/replica/pending-changes";
import { photosPendingLine } from "./photos-pending";

const change = (over: Partial<PendingChange> = {}): PendingChange => ({
  id: "intent-1",
  vaultId: "v1",
  vaultLabel: "Home",
  status: "queued",
  label: "photos: favorite-asset",
  kind: "replica",
  ...over,
});

describe(photosPendingLine, () => {
  it("says nothing when nothing of this app's is outstanding", () => {
    expect(photosPendingLine([])).toBeNull();
    expect(photosPendingLine([change({ label: "tasks: add" })])).toBeNull();
  });

  it("names the connection a queued write waits on", () => {
    expect(photosPendingLine([change()])).toBe("Waiting for a connection.");
  });

  it("names the STEWARD a parked write waits on, from the outbox's own reason", () => {
    expect(
      photosPendingLine([
        change({ status: "parked", reason: "Waiting for Ravi." }),
      ])
    ).toBe("Waiting for Ravi.");
  });

  it("falls back to the owner sentence when a parked write names nobody", () => {
    expect(photosPendingLine([change({ status: "parked" })])).toBe(
      "Waiting for the owner to approve this change."
    );
  });

  it("skips a status the overlay grammar has no rung for rather than coercing it", () => {
    expect(
      photosPendingLine([
        change({ status: "awaiting-change" }),
        change({ id: "intent-2", status: "sending" }),
      ])
    ).toBe("Sending this change.");
  });

  it("ignores another app's outstanding write entirely", () => {
    expect(
      photosPendingLine([
        change({ label: "locker: star-item", status: "parked" }),
        change({ id: "intent-2" }),
      ])
    ).toBe("Waiting for a connection.");
  });
});
