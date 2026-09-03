// Who the Docs seat can name in a grant, phone side (#825).
//
// THREE ANSWERS, and only one of them is a roster: `null` while the read is in
// flight, `null` again where the read fell over and nobody else answered — so
// Docs draws no Share verb rather than a sheet that would call a member
// friendless on the strength of a broken read — and a list (possibly empty)
// once the vault has actually answered.
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GrantAudienceOption } from "@centraid/blueprints/apps/_shared/grant-plane";

import { useDocsGrantAudiences } from "./useDocsGrantAudiences";

const replica = vi.hoisted(() => ({
  value: {
    gatewayBase: "https://gateway.example",
    scopes: [] as unknown[],
    vaultId: "vault-own",
  },
}));
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => replica.value }) as never
);

const rows = vi.hoisted(() => ({
  value: {} as Record<string, Record<string, unknown>[]>,
}));
vi.mock(
  import("../../kit/hooks/useReplicaQuery"),
  () =>
    ({
      useReplicaQuery: (_name: string, query: { entity: string }) => ({
        rows: rows.value[query.entity] ?? [],
      }),
    }) as never
);

vi.mock(
  import("../../kit/share/named-circles"),
  () => ({ useNamedShareCircles: () => [] }) as never
);

const links = vi.hoisted(() => ({
  answer: (): Promise<unknown[]> => Promise.resolve([]),
}));

function linkTo(partyId: string): Record<string, unknown> {
  return {
    vaultA: "vault-own",
    vaultB: `vault-${partyId}`,
    partyIdA: "party-own",
    partyIdB: partyId,
    approved: true,
    revoked: false,
  };
}
vi.mock(
  import("../../lib/replica/links-transport"),
  () => ({ listLinks: () => links.answer() }) as never
);

let root: ReturnType<typeof createRoot> | undefined;

async function read(): Promise<readonly GrantAudienceOption[] | null> {
  const container = document.createElement("div");
  document.body.append(container);
  const seen: (readonly GrantAudienceOption[] | null)[] = [];
  const Probe = (): null => {
    seen.push(useDocsGrantAudiences());
    return null;
  };
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return seen[seen.length - 1] ?? null;
}

describe("the Docs seat's roster, phone side", () => {
  beforeEach(() => {
    replica.value = {
      gatewayBase: "https://gateway.example",
      scopes: [],
      vaultId: "vault-own",
    };
    rows.value = {};
    links.answer = () => Promise.resolve([]);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  it("answers nothing at all while the links read is still in flight", async () => {
    links.answer = () => new Promise(() => {});
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    await expect(read()).resolves.toBeNull();
  });

  it("names the people the vault answered, party-addressed", async () => {
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    links.answer = () => Promise.resolve([linkTo("party-asha")]);
    await expect(read()).resolves.toStrictEqual([
      { kind: "party", id: "party-asha", label: "Asha Rao" },
    ]);
  });

  it("does not offer a person the vault is not linked with", async () => {
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    await expect(read()).resolves.toStrictEqual([]);
  });

  it("answers an EMPTY roster where the vault genuinely knows nobody", async () => {
    await expect(read()).resolves.toStrictEqual([]);
  });

  it("never offers a person queued offline", async () => {
    // A directory entry is a NAME; the link is the address. Offering a name
    // with no address is a promise the product cannot keep — the grant would
    // park forever with nowhere to deliver.
    rows.value = {
      "core.party": [
        { party_id: "pending:intent-1:0", display_name: "Queued friend" },
      ],
    };
    await expect(read()).resolves.toStrictEqual([]);
  });

  it("answers NOT-AN-ANSWER where the links read failed", async () => {
    // Not `[]`, even with People rows in hand: without the links this device
    // cannot tell an addressable person from an unaddressable one, and an
    // empty sheet would call the member friendless on a broken read.
    links.answer = () => Promise.reject(new Error("gateway gone"));
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    await expect(read()).resolves.toBeNull();
  });
});
