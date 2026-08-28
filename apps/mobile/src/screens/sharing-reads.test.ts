// Sharing's read plane (#880), the two rules that keep it honest:
//
//  1. L-READ (#821): "nobody is linked" must never be rendered from "we could
//     not look". A failed read answers ABSENT, and absent is a third state
//     beside loading and read — never `[]`.
//  2. A refusal and an outage are different screens (docs/mobile-offline.md),
//     the same pin `apps/mobile/src/apps/tally/tally-store.test.ts` keeps over
//     the Tally read plane.
//
// Plus the multi-vault rule: up to four vaults are mounted, so the section
// asks all of them and one vault's silence never speaks for the rest.

import { describe, expect, it } from "vitest";

import {
  readShareScopes,
  readShareSection,
  shareAbsentLine,
  sharePartialLine,
  shareReadReach,
} from "./sharing-reads";

const HOME = { vaultId: "vault-home", label: "Home" };
const STUDIO = { vaultId: "vault-studio", label: "Studio" };

describe("one section's answer", () => {
  it("carries rows when the read landed", async () => {
    await expect(
      readShareSection(() => Promise.resolve([{ id: "a" }]), true)
    ).resolves.toStrictEqual({ state: "read", rows: [{ id: "a" }] });
  });

  it("is absent, not empty, when the read failed", async () => {
    const answer = await readShareSection(
      () =>
        Promise.reject(new Error("read shared-space recovery failed (500)")),
      true
    );
    expect(answer.state).toBe("absent");
    // The one thing this must never be: a shape a caller can draw "none" from.
    expect(answer).not.toHaveProperty("rows");
  });

  it("says the gateway refused when the gateway answered", async () => {
    await expect(
      readShareSection(
        () => Promise.reject(new Error("list links (403)")),
        true
      )
    ).resolves.toStrictEqual({ state: "absent", reach: "refused" });
  });

  it("says out of reach when the request never left the device", async () => {
    await expect(
      readShareSection(
        () => Promise.reject(new TypeError("Network request failed")),
        true
      )
    ).resolves.toStrictEqual({ state: "absent", reach: "unreachable" });
  });
});

describe("naming which of the two happened", () => {
  it("reads a rejected fetch as unreachable, and any other error as refused", () => {
    expect(shareReadReach(new TypeError("Network request failed"), true)).toBe(
      "unreachable"
    );
    expect(shareReadReach(new Error("HTTP 500"), true)).toBe("refused");
  });

  it("trusts a replica that already knows the device is offline", () => {
    // No request can have been refused by a gateway this device cannot reach.
    expect(shareReadReach(new Error("HTTP 500"), false)).toBe("unreachable");
  });

  it("gives the two failures different sentences", () => {
    const noun = "Who is linked";
    expect(shareAbsentLine(noun, "unreachable")).not.toBe(
      shareAbsentLine(noun, "refused")
    );
    expect(shareAbsentLine(noun, "unreachable")).toContain("out of reach");
    expect(shareAbsentLine(noun, "refused")).toContain("refused");
    // And neither may be mistakable for the true-empty sentence.
    expect(shareAbsentLine(noun, "refused")).not.toContain("yet");
  });
});

describe("reading every mounted vault", () => {
  it("stamps each row with the vault it came from", async () => {
    const answer = await readShareScopes(
      [HOME, STUDIO],
      (vaultId) => Promise.resolve([{ invitationId: `inv-${vaultId}` }]),
      true
    );
    expect(answer.rows).toStrictEqual([
      {
        invitationId: "inv-vault-home",
        sourceVaultId: "vault-home",
        sourceLabel: "Home",
      },
      {
        invitationId: "inv-vault-studio",
        sourceVaultId: "vault-studio",
        sourceLabel: "Studio",
      },
    ]);
    expect(answer.missed).toStrictEqual([]);
    expect(answer.reach).toBeUndefined();
  });

  it("keeps the vaults that answered when one did not", async () => {
    const answer = await readShareScopes(
      [HOME, STUDIO],
      (vaultId) =>
        vaultId === STUDIO.vaultId
          ? Promise.reject(new TypeError("Network request failed"))
          : Promise.resolve([{ invitationId: "inv-1" }]),
      true
    );
    expect(answer.rows).toHaveLength(1);
    expect(answer.missed).toStrictEqual(["Studio"]);
    expect(answer.reach).toBe("unreachable");
    // A partial answer says so rather than letting one vault stand for four.
    expect(sharePartialLine(answer.missed)).toContain("Studio");
  });

  it("is wholly absent when no vault answered", async () => {
    const answer = await readShareScopes(
      [HOME, STUDIO],
      () =>
        Promise.reject(new Error("read shared-space recovery failed (500)")),
      true
    );
    expect(answer.rows).toStrictEqual([]);
    expect(answer.missed).toStrictEqual(["Home", "Studio"]);
    expect(answer.reach).toBe("refused");
  });

  it("asks every mounted vault, not just the focused one", async () => {
    const asked: string[] = [];
    await readShareScopes(
      [HOME, STUDIO],
      (vaultId) => {
        asked.push(vaultId);
        return Promise.resolve([]);
      },
      true
    );
    expect(asked).toStrictEqual(["vault-home", "vault-studio"]);
  });
});
