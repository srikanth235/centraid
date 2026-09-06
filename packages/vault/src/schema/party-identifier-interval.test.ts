// IDENTITY SCENARIOS — the identifier register (#996 wave 0b, ruling R20(e)).
//
// Three findings of one shape, each driven through a real command path and
// read back through the real resolver (`partyForReach`, which is
// what `social.resolve_identity` and every importer call), never by asserting
// on a raw SELECT:
//
//   1. CURRENT PREFERENCE IS NOT HISTORY. The value index has been partial on
//      the live rows since #916; the primary-preference index was not, so an
//      end-dated primary blocked a new one forever.
//   2. AN INTERVAL RUNS FORWARD. `valid_to < valid_from` was representable.
//   3. A SHORT HANDLE IS NOT GLOBALLY UNIQUE. `@alice` on two services was one
//      row's worth of namespace for two people.

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerAtlasCommands } from "../commands/atlas.js";
import { partyForReach } from "../commands/contact-reach.js";
import { registerPartyCommands } from "../commands/parties.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";

const NOW = "2026-09-06T10:00:00.000Z";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("core.party_identifier — the interval, the preference and the issuer", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerPartyCommands(gw);
    registerAtlasCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function invoke(
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome {
    return gw.invoke(owner, { command, input });
  }

  /** A party with one primary handle, minted by the real party command. */
  function partyWithHandle(name: string, handle: string): string {
    const outcome = invoke("core.add_party", {
      display_name: name,
      identifiers: [{ scheme: "handle", value: handle }],
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  function identifierIdOf(partyId: string, value: string): string {
    const row = db.vault
      .prepare(
        `SELECT identifier_id FROM core_party_identifier
          WHERE party_id = ? AND value = ?`
      )
      .get(partyId, value) as { identifier_id: string } | undefined;
    expect(row, `identifier ${value}`).toBeDefined();
    return row!.identifier_id;
  }

  test("an end-dated primary does not block a new primary for the same scheme", () => {
    const party = partyWithHandle("Alice", "@alice-old");
    const retired = identifierIdOf(party, "@alice-old");

    // Retire it: the row stays as history, which is the whole point of the
    // temporal register.
    expect(
      invoke("atlas.update_row", {
        table: "core.party_identifier",
        id: retired,
        set: { valid_to: NOW },
      }).status
    ).toBe("executed");

    // The replacement. Before R20(e) this failed on
    // `idx_party_identifier_primary`, which spanned history: the retired row
    // still held the one primary slot for (party, 'handle').
    const replacement = invoke("atlas.insert_row", {
      table: "core.party_identifier",
      values: {
        party_id: party,
        scheme: "handle",
        value: "@alice-new",
        is_primary: 1,
        valid_from: NOW,
      },
    });
    expect(replacement.status).toBe("executed");

    // Read through the resolver every importer and `social.resolve_identity`
    // use: the live handle resolves, the retired one does not.
    expect(partyForReach(db.vault, "handle", "@alice-new", NOW)).toBe(party);
    expect(partyForReach(db.vault, "handle", "@alice-old", NOW)).toBeNull();
  });

  test("two live primaries for one (party, scheme) are still refused", () => {
    // The index narrowed to the live rows; it did not stop existing.
    const party = partyWithHandle("Bruno", "@bruno");
    const second = invoke("atlas.insert_row", {
      table: "core.party_identifier",
      values: {
        party_id: party,
        scheme: "handle",
        value: "@bruno-alt",
        is_primary: 1,
        valid_from: NOW,
      },
    });
    expect(second.status).toBe("failed");
  });

  test("an inverted interval is refused", () => {
    const party = partyWithHandle("Chi", "@chi");
    const inverted = invoke("atlas.insert_row", {
      table: "core.party_identifier",
      values: {
        party_id: party,
        scheme: "handle",
        value: "@chi-alt",
        is_primary: 0,
        valid_from: "2026-09-06T10:00:00.000Z",
        valid_to: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(inverted.status).toBe("failed");
  });

  test("the same short handle in two issuers is two identities", () => {
    const one = partyWithHandle("Dara", "@alice");
    const two = invoke("core.add_party", { display_name: "Eve" });
    expect(two.status).toBe("executed");
    const otherParty = (two as { output: { party_id: string } }).output
      .party_id;

    // Same scheme, same value, a different namespace. Before the issuer column
    // this was refused by `core_party_identifier_live_idx` as an identity
    // fork — which it is only when the two values mean the same thing.
    const elsewhere = invoke("atlas.insert_row", {
      table: "core.party_identifier",
      values: {
        party_id: otherParty,
        scheme: "handle",
        value: "@alice",
        issuer: "example.social",
        is_primary: 1,
        valid_from: NOW,
      },
    });
    expect(elsewhere.status).toBe("executed");

    // And the fork the index does still refuse: same scheme, same value, same
    // (absent) namespace.
    const fork = invoke("atlas.insert_row", {
      table: "core.party_identifier",
      values: {
        party_id: otherParty,
        scheme: "handle",
        value: "@alice",
        is_primary: 0,
        valid_from: NOW,
      },
    });
    expect(fork.status).toBe("failed");
    expect(partyForReach(db.vault, "handle", "@alice", NOW)).toBe(one);
  });
});
