import crypto from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, afterEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { vaultIdentityPublicKey } from "@centraid/vault";

import { GatewayDatabase } from "./gateway-db.js";
import { judgeEdgeCrossing } from "./link-crossing.js";
import { VaultLinksStore } from "./vault-links-store.js";

const databases: GatewayDatabase[] = [];
const dirs: string[] = [];

const key = (): string =>
  vaultIdentityPublicKey(crypto.randomBytes(32)).toString("base64");

const OWNERS: Record<string, string> = {
  "vlt-work": "owner-priya",
  "vlt-personal": "owner-priya",
  "vlt-daughter": "owner-maya",
};

describe(judgeEdgeCrossing, () => {
  afterEach(async () => {
    for (const database of databases.splice(0)) database.close();
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function setup(): Promise<VaultLinksStore> {
    const dir = await tempDir("link-crossing-");
    dirs.push(dir);
    const database = GatewayDatabase.open(dir);
    databases.push(database);
    return new VaultLinksStore(database);
  }

  const judge = (links: VaultLinksStore, from: string, to: string) =>
    judgeEdgeCrossing(
      { links, ownerOf: (vaultId) => OWNERS[vaultId] },
      from,
      to
    );

  function linkRemote(links: VaultLinksStore, localVaultId: string) {
    const ticket = links.tickets.mint(localVaultId, key());
    return links.redeem({
      ticketId: ticket.ticketId,
      secret: ticket.secret,
      peerVaultId: "vlt-far",
      peerPublicKey: key(),
      route: { endpointId: "ep-far", relayHints: [], assertedAt: Date.now() },
      peerLabel: "Priya's brother",
      localLabel: "Home",
    })!;
  }

  test("same owner needs no link at all", async () => {
    const links = await setup();
    expect(judge(links, "vlt-work", "vlt-personal")).toStrictEqual({
      state: "same-owner",
    });
    expect(links.list()).toHaveLength(0);
  });

  test("cross-owner on one machine: approved crosses, with no route to dial", async () => {
    const links = await setup();
    const link = links.propose({
      fromVaultId: "vlt-work",
      fromPublicKey: key(),
      toVaultId: "vlt-daughter",
      toPublicKey: key(),
    });
    links.approve(link.linkId, "vlt-daughter");
    expect(judge(links, "vlt-work", "vlt-daughter")).toStrictEqual({
      state: "linked",
      linkId: link.linkId,
    });
  });

  test("cross-owner on one machine: one approval is not enough", async () => {
    const links = await setup();
    links.propose({
      fromVaultId: "vlt-work",
      fromPublicKey: key(),
      toVaultId: "vlt-daughter",
      toPublicKey: key(),
    });
    expect(judge(links, "vlt-work", "vlt-daughter")).toStrictEqual({
      state: "not_found",
    });
  });

  test("a vault elsewhere crosses on the same approval, plus a route", async () => {
    const links = await setup();
    const peer = linkRemote(links, "vlt-work");
    const crossing = judge(links, "vlt-work", "vlt-far");
    expect(crossing).toMatchObject({
      state: "linked",
      linkId: peer.linkId,
      route: { endpointId: "ep-far" },
    });
  });

  test("an unlinked vault elsewhere is the SAME refusal as an unapproved one", async () => {
    const links = await setup();
    expect(judge(links, "vlt-work", "vlt-far")).toStrictEqual({
      state: "not_found",
    });
    expect(judge(links, "vlt-work", "vlt-nobody-has-heard-of")).toStrictEqual({
      state: "not_found",
    });
  });

  test("revoking a remote link refuses it again", async () => {
    const links = await setup();
    const peer = linkRemote(links, "vlt-work");
    expect(judge(links, "vlt-work", "vlt-far")).toMatchObject({
      state: "linked",
    });
    links.revoke(peer.linkId);
    expect(judge(links, "vlt-work", "vlt-far")).toStrictEqual({
      state: "not_found",
    });
  });

  test("an origin this gateway does not hold can never send", async () => {
    const links = await setup();
    linkRemote(links, "vlt-work");
    expect(judge(links, "vlt-far", "vlt-work")).toStrictEqual({
      state: "not_found",
    });
  });
});
