// Egress answers are rows of the ONE plane (#928 A6), not a side table: the
// principal is the actor that acts, the subject is the destination, and the
// verb is the capability. Nothing here is a gate — an absent row is simply no
// answer, which is what the outbox and the enrichment gate both refuse on.

import { describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import { isRegisteredAuthority } from "./authority-registry.js";
import {
  EGRESS_SUBJECT_TYPE,
  egressPrincipalKind,
  isLiveEgressAuthority,
  listEgressAuthorities,
  liveEgressAuthorityId,
  liveEgressAuthorityIdsFor,
  recordEgressAuthority,
  revokeAllEgressAuthorities,
  revokeEgressAuthority,
} from "./egress-authority.js";

function vault(): { db: ReturnType<typeof openVaultDb>; owner: string } {
  const fixture = bootstrappedVault(
    { openVaultDb, bootstrapVault },
    { ownerName: "Egress owner" }
  );
  return { db: fixture.db, owner: fixture.boot.ownerPartyId };
}

const KEY = {
  actorId: "photos/digest",
  actorKind: "ai_agent",
  verb: "gmail.send",
  target: "ada@example.com",
} as const;

describe("egress answers in the one authority plane", () => {
  test("an absent row is no answer", () => {
    const { db } = vault();
    expect(liveEgressAuthorityId(db.vault, KEY)).toBeUndefined();
    expect(listEgressAuthorities(db.vault)).toStrictEqual([]);
  });

  test("an automation actor mints an automation principal; the owner's surfaces mint a device one", () => {
    const { db, owner } = vault();
    const agent = recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:00:00.000Z",
    });
    const surface = recordEgressAuthority(db.vault, {
      ...KEY,
      actorId: "docs",
      actorKind: "app",
      grantedBy: owner,
      now: "2026-09-04T00:00:01.000Z",
    });
    const byId = new Map(
      listEgressAuthorities(db.vault).map((row) => [row.authorityId, row])
    );
    expect(byId.get(agent)?.principalKind).toBe("automation");
    expect(byId.get(surface)?.principalKind).toBe("device");
    expect(egressPrincipalKind("owner")).toBe("device");
    expect(byId.get(agent)?.target).toBe(KEY.target);
    expect(byId.get(agent)?.verb).toBe(KEY.verb);
  });

  test("the triple is registered for both principals", () => {
    for (const kind of ["automation", "device"]) {
      expect(isRegisteredAuthority(kind, EGRESS_SUBJECT_TYPE, KEY.verb)).toBe(
        true
      );
    }
  });

  test("re-minting a live answer returns the row that already stands", () => {
    const { db, owner } = vault();
    const first = recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:00:00.000Z",
    });
    const again = recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:01:00.000Z",
    });
    expect(again).toBe(first);
    expect(listEgressAuthorities(db.vault)).toHaveLength(1);
  });

  test("a revoked answer stops answering but stays as history, and re-answering inserts", () => {
    const { db, owner } = vault();
    const first = recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:00:00.000Z",
    });
    revokeEgressAuthority(db.vault, first, "2026-09-04T00:02:00.000Z");
    expect(isLiveEgressAuthority(db.vault, first)).toBe(false);
    expect(liveEgressAuthorityId(db.vault, KEY)).toBeUndefined();
    const second = recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:03:00.000Z",
    });
    expect(second).not.toBe(first);
    expect(listEgressAuthorities(db.vault)).toHaveLength(2);
    expect(liveEgressAuthorityIdsFor(db.vault, KEY.actorId)).toStrictEqual([
      second,
    ]);
  });

  test("the quarantine sweep ends every live egress answer at once", () => {
    const { db, owner } = vault();
    recordEgressAuthority(db.vault, {
      ...KEY,
      grantedBy: owner,
      now: "2026-09-04T00:00:00.000Z",
    });
    recordEgressAuthority(db.vault, {
      ...KEY,
      target: "grace@example.com",
      grantedBy: owner,
      now: "2026-09-04T00:00:01.000Z",
    });
    expect(
      revokeAllEgressAuthorities(db.vault, "2026-09-04T01:00:00.000Z")
    ).toBe(2);
    expect(liveEgressAuthorityIdsFor(db.vault, KEY.actorId)).toStrictEqual([]);
    expect(
      revokeAllEgressAuthorities(db.vault, "2026-09-04T02:00:00.000Z")
    ).toBe(0);
  });
});
