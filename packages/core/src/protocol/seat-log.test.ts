import { describe, expect, it } from "vitest";

import { ROUTES } from "./routes.js";
import {
  SEAT_LOG_MAX_PAGE,
  SEAT_SNAPSHOT_EPOCH_HEADER,
  SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER,
  SEAT_SNAPSHOT_SEQ_HEADER,
} from "./seat-log.js";

describe("seat door constants", () => {
  it("names the snapshot headers and the log page ceiling", () => {
    expect(SEAT_SNAPSHOT_SEQ_HEADER).toBe("x-centraid-seat-seq");
    expect(SEAT_SNAPSHOT_EPOCH_HEADER).toBe("x-centraid-seat-epoch");
    expect(SEAT_SNAPSHOT_SCHEMA_EPOCH_HEADER).toBe("x-centraid-schema-epoch");
    expect(SEAT_LOG_MAX_PAGE).toBe(10_000);
    expect(ROUTES.vaultSeatSnapshot).toContain("/seat/snapshot");
    expect(ROUTES.vaultSeatLog).toContain("/seat/log");
    expect(ROUTES.vaultSeatLockerKey).toContain("/seat/locker-key");
  });
});
