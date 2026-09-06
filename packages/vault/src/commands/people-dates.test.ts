import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerPeopleCommands } from "./people.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("people important-date month_day", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerPeopleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function invoke(command: string, input: Record<string, unknown>) {
    return gw.invoke(owner, {
      command,
      input,
    });
  }

  function addPerson(): string {
    const outcome = invoke("people.add_person", {
      display_name: "Maya Chen",
      cadence_days: 14,
    });
    expect(outcome.status).toBe("executed");
    assert(outcome.status === "executed");
    return (outcome.output as { party_id: string }).party_id;
  }

  // SHAPE IS THE SCHEMA'S, THE CALENDAR IS THE OPERATION'S (#996, ruling R21;
  // drift ONT-26). This command's input pattern used to spell out the length
  // of every month — its own private copy of the calendar, which is exactly
  // why `atlas.insert_row` could write February 31 while this command refused
  // it. A month or a day outside 01-12 / 01-31 is still a malformed input; a
  // day that does not exist is now `people.important_date.write`'s answer, and
  // every writer gets that same sentence.
  test("month_day validation refuses a malformed field", () => {
    const partyId = addPerson();
    for (const monthDay of ["13-01", "00-10", "06-00"]) {
      const outcome = invoke("people.add_important_date", {
        party_id: partyId,
        label: "Anniversary",
        month_day: monthDay,
      });
      expect(outcome.status, monthDay).toBe("failed");
      assert(outcome.status === "failed");
      expect(outcome.reason).toBe("input schema violation");
    }
  });

  test("month_day validation refuses a day that does not exist", () => {
    const partyId = addPerson();
    for (const monthDay of ["02-30", "04-31"]) {
      const outcome = invoke("people.add_important_date", {
        party_id: partyId,
        label: "Anniversary",
        month_day: monthDay,
      });
      expect(outcome.status, monthDay).toBe("failed");
      assert(outcome.status === "failed");
      expect(outcome.reason).toContain("is not a day of the year");
    }
  });

  test("February 29 is a real month_day", () => {
    const partyId = addPerson();
    const outcome = invoke("people.add_important_date", {
      party_id: partyId,
      label: "Birthday",
      month_day: "02-29",
    });
    expect(outcome.status).toBe("executed");
  });
});
