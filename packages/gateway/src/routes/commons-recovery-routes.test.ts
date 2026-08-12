/* The owner-tier doors for Commons steward-absence recovery (#731): the read
 * surface a member renders its steward status from, and the ceremony itself. */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import {
  commonsSeats,
  compileCommons,
  createCommonsGrant,
  readCommonsGrant,
} from "@centraid/vault";

import { commonsObservabilitySection } from "../serve/commons-observability.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { makeSide, seedPhoto } from "../serve/peer-give.test-fixtures.js";
import type { Side } from "../serve/peer-give.test-fixtures.js";
import {
  COMMONS_RECOVERY_PATH,
  makeCommonsRecoveryRouteHandler,
} from "./commons-recovery-routes.js";

const servers: http.Server[] = [];

function serve(member: Side): Promise<string> {
  const handler = makeCommonsRecoveryRouteHandler({
    enrollments: EnrollmentStore.open(member.gatewayDb),
    vaultFor: (vaultId) =>
      vaultId === member.vaultId ? member.vault : undefined,
  });
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** A steward with one shared photo and a member holding the full replica. */
function shared(label: string): {
  steward: Side;
  member: Side;
  grantId: string;
} {
  const steward = makeSide(`${label}-steward`);
  const member = makeSide(`${label}-member`);
  const now = new Date().toISOString();
  const photo = seedPhoto(steward, label);
  const grant = createCommonsGrant({
    origin: steward.vault.vault,
    ownerPartyId: steward.ownerPartyId,
    ownerVaultId: steward.vaultId,
    ownerVault: steward.vault,
    containerType: "media.asset",
    containerId: photo.assetId,
    members: [
      {
        partyId: member.ownerPartyId,
        capability: "read+write",
        vaultId: member.vaultId,
        vault: member.vault,
        vaultPublicKey: member.publicKey,
      },
    ],
    now,
  });
  compileCommons({
    steward: steward.vault,
    stewardVaultId: steward.vaultId,
    grantId: grant.grantId,
    seats: commonsSeats({
      steward: steward.vault.vault,
      grantId: grant.grantId,
      stewardVaultId: steward.vaultId,
      vaultFor: (vaultId) =>
        vaultId === steward.vaultId
          ? steward.vault
          : vaultId === member.vaultId
            ? member.vault
            : undefined,
    }),
    now,
  });
  return { steward, member, grantId: grant.grantId };
}

describe("commons recovery routes", () => {
  afterEach(() => {
    while (servers.length > 0) servers.pop()?.close();
  });

  test("GET reports the steward status and instrumentation for each grant", async () => {
    const { member, grantId } = shared("route-read");
    const url = await serve(member);
    const res = await fetch(
      `${url}${COMMONS_RECOVERY_PATH}?actorVaultId=${member.vaultId}`,
      { headers: { [AUTHED_DEVICE_HEADER]: member.deviceId } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      vaultId: string;
      grants: {
        grantId: string;
        containerType: string;
        reachableRatio: number | null;
        steward: { presence: string };
        opLog: { rows: number; lastSequence: number };
      }[];
    };
    expect(body.vaultId).toBe(member.vaultId);
    const grant = body.grants.find((entry) => entry.grantId === grantId);
    // Never pulled yet, so the seat says so rather than inventing an absence.
    expect(grant?.steward.presence).toBe("unknown");
    expect(grant?.reachableRatio).toBeNull();
    expect(grant?.containerType).toBe("media.asset");
    expect(grant?.opLog.lastSequence).toBe(
      readCommonsGrant(member.vault.vault, grantId).lastSequence
    );
  });

  test("POST re-founds the grant and is idempotent under retry", async () => {
    const { member, grantId } = shared("route-recover");
    const url = await serve(member);
    const post = async () =>
      fetch(`${url}${COMMONS_RECOVERY_PATH}`, {
        method: "POST",
        headers: {
          [AUTHED_DEVICE_HEADER]: member.deviceId,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actorVaultId: member.vaultId, grantId }),
      });

    const first = await post();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      state: string;
      grantId: string;
      replayed: boolean;
      invitedPartyIds: string[];
    };
    expect(firstBody.state).toBe("recovered");
    expect(firstBody.replayed).toBe(false);
    // The old steward is invited, not joined: consent stays theirs to give.
    expect(firstBody.invitedPartyIds).toContain(
      readCommonsGrant(member.vault.vault, grantId).stewardPartyId
    );

    const second = await post();
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      grantId: string;
      replayed: boolean;
    };
    expect(secondBody.grantId).toBe(firstBody.grantId);
    expect(secondBody.replayed).toBe(true);
  });

  test("POST refuses with 409 while the seat is parked on a divergence fault", async () => {
    const { member, grantId } = shared("route-parked");
    member.vault.vault
      .prepare(
        `INSERT INTO share_commons_steward_contact
           (grant_id, member_vault_id, last_outcome, fault, faulted_at, attempts)
         VALUES (?, ?, 'parked', 'history-diverged', ?, 1)`
      )
      .run(grantId, member.vaultId, new Date().toISOString());
    const url = await serve(member);
    const res = await fetch(`${url}${COMMONS_RECOVERY_PATH}`, {
      method: "POST",
      headers: {
        [AUTHED_DEVICE_HEADER]: member.deviceId,
        "content-type": "application/json",
      },
      body: JSON.stringify({ actorVaultId: member.vaultId, grantId }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toStrictEqual({
      state: "refused",
      reason: "parked-on-fault",
    });
  });

  test("an unidentified caller is refused before any vault is touched", async () => {
    const { member } = shared("route-anon");
    const url = await serve(member);
    const res = await fetch(
      `${url}${COMMONS_RECOVERY_PATH}?actorVaultId=${member.vaultId}`
    );
    expect(res.status).toBe(403);
  });
});

describe("commons diagnostics section", () => {
  test("summarizes mounted vaults and skips the ones without live handles", () => {
    const { member, grantId } = shared("section");
    const section = commonsObservabilitySection({
      vaults: [
        { vaultId: member.vaultId, db: member.vault },
        { vaultId: "vlt_not_mounted" },
      ],
    });
    expect(section.commons).toHaveLength(1);
    expect(section.commons[0]?.grants.map((entry) => entry.grantId)).toContain(
      grantId
    );
  });
});
