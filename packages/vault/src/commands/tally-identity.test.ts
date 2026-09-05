// ONE PARTY PER PERSON, AND THEREFORE ONE HUE (#883 O-identity). The three ways
// into `tally.add_friend` each fail differently, so each is asserted: a
// `party_id` mints nothing; `email`/`phone` resolve through the ONE dedupe
// module (`contact-reach.ts`), and a miss mints AND BINDS so the next caller
// gets the hit; a name alone mints, because A NAME IS NEVER A KEY — two people
// are called Ann, and folding them on a string is worse than a duplicate.
import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { registerPeopleOrganizeCommands } from "./people-organize.js";
import { registerPeopleCommands } from "./people.js";
import { registerTallyCommands } from "./tally.js";

let db: VaultDb;
let gw: Gateway;
let owner: Credential;

interface AddFriendOut {
  party_id: string;
  reused_party: boolean;
}

describe("tally.add_friend enrolls an existing party rather than minting a second", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Alex" });
    gw = createGateway(db);
    registerTallyCommands(gw);
    registerPeopleCommands(gw);
    registerPeopleOrganizeCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  const invoke = (command: string, input: Record<string, unknown>) =>
    gw.invoke(owner, { command, input });

  function out<T>(outcome: ReturnType<typeof invoke>): T {
    expect(outcome.status).toBe("executed");
    return (outcome as { output: T }).output;
  }

  const partyCount = (): number =>
    (
      db.vault
        .prepare("SELECT count(*) AS n FROM core_party WHERE kind = 'person'")
        .get() as { n: number }
    ).n;

  const friendRows = (partyId: string): number =>
    (
      db.vault
        .prepare("SELECT count(*) AS n FROM tally_friend WHERE party_id = ?")
        .get(partyId) as { n: number }
    ).n;

  test("a named party is enrolled, not minted a second time", () => {
    const person = out<{ party_id: string }>(
      invoke("people.add_person", { cadence_days: 30, display_name: "Priya" })
    ).party_id;
    const before = partyCount();

    const added = out<AddFriendOut>(
      invoke("tally.add_friend", { name: "Priya", party_id: person })
    );

    expect(added.party_id).toBe(person);
    expect(added.reused_party).toBe(true);
    expect(partyCount()).toBe(before);
    expect(friendRows(person)).toBe(1);
  });

  test("an address the vault already knows resolves to its party", () => {
    const person = out<{ party_id: string }>(
      invoke("people.add_person", { cadence_days: 0, display_name: "Sam" })
    ).party_id;
    out(
      invoke("people.save_contact_channel", {
        kind: "email",
        party_id: person,
        value: "Sam@Example.COM",
      })
    );
    const before = partyCount();

    // A different spelling of the same address: the dedupe key normalizes it.
    const added = out<AddFriendOut>(
      invoke("tally.add_friend", { email: "sam@example.com", name: "Sam" })
    );

    expect(added.party_id).toBe(person);
    expect(added.reused_party).toBe(true);
    expect(partyCount()).toBe(before);
  });

  test("an address nobody holds mints once and binds, so the next call hits", () => {
    const first = out<AddFriendOut>(
      invoke("tally.add_friend", { email: "ana@example.com", name: "Ana" })
    );
    expect(first.reused_party).toBe(false);

    const second = out<AddFriendOut>(
      invoke("tally.add_friend", { email: "ANA@example.com", name: "Ana" })
    );

    expect(second.party_id).toBe(first.party_id);
    expect(second.reused_party).toBe(true);
    expect(friendRows(first.party_id)).toBe(1);
  });

  test("a name alone still mints — a name is never a key", () => {
    const one = out<AddFriendOut>(invoke("tally.add_friend", { name: "Ann" }));
    const two = out<AddFriendOut>(invoke("tally.add_friend", { name: "Ann" }));

    expect(two.party_id).not.toBe(one.party_id);
    expect(one.reused_party).toBe(false);
    expect(two.reused_party).toBe(false);
  });

  test("a party_id nobody holds is refused rather than silently minted", () => {
    const outcome = invoke("tally.add_friend", {
      name: "Ghost",
      party_id: "not-a-party",
    });
    expect(["denied", "failed"]).toContain(outcome.status);
  });
});
