// Client↔gateway seam laws for the household roster (#599 L2) — the module had
// no test file (#656 Layer 1B). Two laws carry the design: a gateway with no
// device plane (the desktop embed) has no roster and must read as EMPTY rather
// than as a failure, and removing the last owner of a vault is refused until the
// caller echoes that vault's name back. Shared harness in
// gateway-client-seam-fixtures.ts.

import { describe, expect, it } from "vitest";

import {
  installSeamContractHarness,
  json,
  members,
  respond,
  sent,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

describe("household roster seam", () => {
  it("law: each roster verb rides its documented route and method", async () => {
    await expect(members.listGatewayMembers()).resolves.toMatchObject([
      { memberId: "m-1", label: "Ada", deviceCount: 2 },
    ]);
    await expect(members.createGatewayMember("Grace")).resolves.toMatchObject({
      memberId: "m-2",
      label: "Grace",
    });
    await expect(
      members.renameGatewayMember("m-1", "Ada L")
    ).resolves.toMatchObject({ memberId: "m-1", label: "Ada L" });
    await members.removeGatewayMember("m-1");

    expect(wireLog()).toStrictEqual([
      "GET /centraid/_gateway/members",
      "POST /centraid/_gateway/members",
      "PATCH /centraid/_gateway/members/m-1",
      "DELETE /centraid/_gateway/members/m-1",
    ]);
  });

  it("law: a gateway with no device plane reports an empty roster, not a failure", async () => {
    respond(
      "GET /centraid/_gateway/members",
      () => new Response("no device plane", { status: 404 })
    );

    await expect(members.listGatewayMembers()).resolves.toStrictEqual([]);
  });

  it("law: only the missing-plane 404 is swallowed — every other failure reaches the UI", async () => {
    respond(
      "GET /centraid/_gateway/members",
      () => new Response("nope", { status: 403 })
    );

    await expect(members.listGatewayMembers()).rejects.toMatchObject({
      code: "auth_required",
    });
  });

  it("law: an absent members array reads as an empty roster", async () => {
    respond("GET /centraid/_gateway/members", () => json({}));

    await expect(members.listGatewayMembers()).resolves.toStrictEqual([]);
  });

  it("law: a member id is percent-encoded into the path, never interpolated raw", async () => {
    respond("PATCH /centraid/_gateway/members/m%2F1", () =>
      json({ member: { memberId: "m/1", label: "Ada" } })
    );

    await expect(
      members.renameGatewayMember("m/1", "Ada")
    ).resolves.toMatchObject({ memberId: "m/1" });
    expect(wireLog()).toStrictEqual(["PATCH /centraid/_gateway/members/m%2F1"]);
  });

  it("law: adding a person names only their label — roles come from a pairing ticket", async () => {
    await members.createGatewayMember("Grace");

    expect(sentJson("POST /centraid/_gateway/members")).toStrictEqual({
      label: "Grace",
    });
    expect(
      sent("POST /centraid/_gateway/members").headers.get("content-type")
    ).toBe("application/json");
  });

  it("law: an unconfirmed removal sends an empty body, never an absent one", async () => {
    await members.removeGatewayMember("m-1");

    expect(sentJson("DELETE /centraid/_gateway/members/m-1")).toStrictEqual({});
  });

  it("law: removing the last owner must echo the vault name back", async () => {
    respond("DELETE /centraid/_gateway/members/m-1", (request) => {
      const body = JSON.parse(String(request.body)) as {
        confirmLastAdmin?: string;
      };
      return body.confirmLastAdmin === "Home"
        ? json({ removed: true, memberId: "m-1", devices: 2 })
        : new Response("last owner of Home", { status: 409 });
    });

    await expect(members.removeGatewayMember("m-1")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      members.removeGatewayMember("m-1", { confirmLastAdmin: "Home" })
    ).resolves.toStrictEqual({ removed: true, memberId: "m-1", devices: 2 });
  });

  it("law: removing a person is one atomic act that reports the devices it took", async () => {
    await expect(members.removeGatewayMember("m-1")).resolves.toStrictEqual({
      removed: true,
      memberId: "m-1",
      devices: 2,
    });
  });
});
