import { describe, expect, it } from "vitest";

import * as subscription from "./replica-subscription.js";
import {
  assertShapeNamespaceFree,
  isShareShapeId,
  judgeSubscriberCredential,
  PEER_REPLICA_BLOB_PATH,
  PEER_REPLICA_BOOTSTRAP_PATH,
  PEER_REPLICA_CHANGES_PATH,
  PEER_REPLICA_INTENTS_PATH,
  PEER_REPLICA_PATHS,
  REPLICA_POST_ADMISSION_CONTRACT,
  SHARE_SHAPE_SIGIL,
  shareShapeGrantId,
  shareShapeId,
  subscriberQuery,
} from "./replica-subscription.js";
import { ROUTE_PATHS } from "./routes.js";

const GRANT = "01920000-0000-7000-8000-00000000abcd";

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("the subscriber contract", () => {
  it("puts every subscription path on the peer plane and nowhere else", () => {
    for (const path of PEER_REPLICA_PATHS) {
      expect(path.startsWith("/centraid/_peer/replica/")).toBe(true);
      // A link must never reach a device-tier route: not the same path, and
      // not a prefix of one either, since dispatch is prefix-keyed.
      for (const route of ROUTE_PATHS) {
        expect(path).not.toBe(route);
        expect(route.startsWith(path)).toBe(false);
        expect(path.startsWith(route)).toBe(false);
      }
    }
    expect(new Set(PEER_REPLICA_PATHS).size).toBe(PEER_REPLICA_PATHS.length);
    expect([...PEER_REPLICA_PATHS].sort()).toStrictEqual(
      [
        PEER_REPLICA_BOOTSTRAP_PATH,
        PEER_REPLICA_CHANGES_PATH,
        PEER_REPLICA_BLOB_PATH,
        PEER_REPLICA_INTENTS_PATH,
      ].sort()
    );
  });

  it("keeps the grant-keyed shape namespace disjoint from the app-keyed one", () => {
    const shapeId = shareShapeId(GRANT);
    expect(shapeId).toBe(`${SHARE_SHAPE_SIGIL}${GRANT}`);
    expect(shareShapeGrantId(shapeId)).toBe(GRANT);
    // The app-keyed form is `${appId}:${24 hex}` — never the sigil.
    expect(isShareShapeId("photos:0123456789abcdef01234567")).toBe(false);
    expect(
      shareShapeGrantId("photos:0123456789abcdef01234567")
    ).toBeUndefined();
    expect(isShareShapeId(SHARE_SHAPE_SIGIL)).toBe(false);
    expect(() => assertShapeNamespaceFree("photos")).not.toThrow();
    expect(() => assertShapeNamespaceFree(`x${SHARE_SHAPE_SIGIL}y`)).toThrow(
      /collide/u
    );
    expect(() => shareShapeId("a/b")).toThrow(RangeError);
    expect(() => shareShapeId("")).toThrow(RangeError);
  });

  it("judges every subscriber credential to a state and carries no secret", () => {
    const ok = judgeSubscriberCredential(
      params({
        originVaultId: "vault-origin",
        audienceVaultId: "vault-audience",
        shapeId: shareShapeId(GRANT),
      })
    );
    expect(ok.state).toBe("ok");
    if (ok.state !== "ok") return;
    // Identity is the peer proof plus the link pair; a credential that carried
    // a bearer value would outlive the link that authorized it.
    for (const key of Object.keys(ok.credential))
      expect(key).not.toMatch(/secret|token|proof|key|signature/iu);
    expect(subscriberQuery(ok.credential)).toContain("audienceVaultId=");

    expect(judgeSubscriberCredential(params({})).state).toBe("bad_request");
    expect(
      judgeSubscriberCredential(
        params({
          originVaultId: "same",
          audienceVaultId: "same",
          shapeId: shareShapeId(GRANT),
        })
      ).state
    ).toBe("bad_request");
    expect(
      judgeSubscriberCredential(
        params({
          originVaultId: "vault-origin",
          audienceVaultId: "vault-audience",
          shapeId: "photos:0123456789abcdef01234567",
        })
      ).state
    ).toBe("bad_request");
  });

  it("respells nothing that lives after admission", () => {
    // The whole point of the issue: admission differs, the replica contract
    // does not. This module may export ADMISSION names only — a second name
    // for a cursor, a row version or a change batch would be a second dialect.
    const postAdmission = new Set(REPLICA_POST_ADMISSION_CONTRACT);
    const collisions = Object.entries(subscription)
      .filter(([name]) => name !== "REPLICA_POST_ADMISSION_CONTRACT")
      .flatMap(([name, value]) => [
        name,
        ...(typeof value === "string" ? [value] : []),
      ])
      .filter((candidate) => postAdmission.has(candidate));
    expect(collisions).toStrictEqual([]);
    expect(Object.isFrozen(REPLICA_POST_ADMISSION_CONTRACT)).toBe(true);
    expect(REPLICA_POST_ADMISSION_CONTRACT).toContain("rowVersion");
    expect(REPLICA_POST_ADMISSION_CONTRACT).toContain("commitId");
  });
});
