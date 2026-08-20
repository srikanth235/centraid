// @vitest-environment jsdom
// Photos' way into the grant sheet, phone seat (#825): the REFUSALS, spoken
// before a sheet opens, and the mapping law they stand on.
//
// Four facts the screen must keep apart — no gateway session, a roster that
// named somebody, a roster that answered nobody, and a roster half of which
// could not be read. The last one used to be spoken as the third, which told a
// member with a full People directory that they knew nobody.
//
// The hook is driven inside a probe component: what reached the status line,
// and whether the sheet opened, are the whole observable outcome of a refusal.

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NOBODY_TO_SHARE_WITH,
  ROSTER_UNREADABLE,
} from "@centraid/blueprints/apps/_shared/grant-audiences";

import {
  NO_GATEWAY_TO_SHARE_THROUGH,
  usePhotoGrantEntry,
} from "./photo-grants";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const replica = vi.hoisted(() => ({
  value: {
    gatewayBase: "https://gateway.example",
    scopes: [] as unknown[],
    session: { token: "t" } as unknown,
    vaultId: "vault-own",
  },
}));
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () => ({ useReplica: () => replica.value }) as never
);

// The replica rows each query answers, by entity. Real reads reach the Expo
// runtime; the roster's SHAPE is what this suite is about, not its transport.
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

const links = vi.hoisted(() => ({
  answer: (): Promise<unknown[]> => Promise.resolve([]),
}));
vi.mock(
  import("../../lib/replica/links-transport"),
  () => ({ listLinks: () => links.answer() }) as never
);

interface Entry {
  audiences: readonly { label: string }[];
  visible: boolean;
  request: () => void;
  dismiss: () => void;
}

let root: ReturnType<typeof createRoot> | undefined;

/** Press *Share* and hand back the sentences and whether the sheet opened. */
async function press(): Promise<{
  said: string[];
  opened: boolean;
  named: readonly { label: string }[];
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const said: string[] = [];
  const seen: Entry[] = [];
  const Probe = (): null => {
    seen.push(usePhotoGrantEntry((message) => said.push(message)));
    return null;
  };
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Probe));
  });
  await act(async () => {
    seen.at(-1)?.request();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const last = seen.at(-1);
  return { said, opened: Boolean(last?.visible), named: last?.audiences ?? [] };
}

describe("Photos' grant entry, phone seat", () => {
  beforeEach(() => {
    replica.value = {
      gatewayBase: "https://gateway.example",
      scopes: [],
      session: { token: "t" },
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

  it("names the missing gateway, and reads no roster at all without one", async () => {
    replica.value = { ...replica.value, session: null, gatewayBase: "" };
    let asked = false;
    links.answer = () => {
      asked = true;
      return Promise.resolve([]);
    };
    const { said, opened } = await press();
    expect(said).toStrictEqual([NO_GATEWAY_TO_SHARE_THROUGH]);
    expect(opened).toBe(false);
    expect(asked).toBe(false);
  });

  it("opens over the people the roster named, silently", async () => {
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    const { said, opened, named } = await press();
    expect(said).toStrictEqual([]);
    expect(opened).toBe(true);
    expect(named.map((option) => option.label)).toStrictEqual(["Asha Rao"]);
  });

  it("never offers a person queued offline — that id names nobody yet", async () => {
    // The mapping law (`grantAudiencesFrom`) is what drops them; this pins that
    // Photos composes it rather than restating a looser rule of its own.
    rows.value = {
      "core.party": [
        { party_id: "pending:intent-1:0", display_name: "Queued friend" },
      ],
    };
    const { said, opened } = await press();
    expect(said).toStrictEqual([NOBODY_TO_SHARE_WITH]);
    expect(opened).toBe(false);
  });

  it("says NOBODY YET for a roster that answered, and answered empty", async () => {
    const { said, opened } = await press();
    expect(said).toStrictEqual([NOBODY_TO_SHARE_WITH]);
    expect(opened).toBe(false);
  });

  it("says the READ FAILED where the links read fell over and People named nobody", async () => {
    links.answer = () => Promise.reject(new Error("gateway gone"));
    const { said, opened } = await press();
    expect(said).toStrictEqual([ROSTER_UNREADABLE]);
    expect(said).not.toContain(NOBODY_TO_SHARE_WITH);
    expect(opened).toBe(false);
  });

  it("still opens on the People rows when only the links read fell over", async () => {
    // A failed links read is not a reason to withhold the people this member
    // added: it only becomes an unreadable roster when nobody else answered.
    links.answer = () => Promise.reject(new Error("gateway gone"));
    rows.value = {
      "core.party": [{ party_id: "party-asha", display_name: "Asha Rao" }],
    };
    const { said, opened, named } = await press();
    expect(said).toStrictEqual([]);
    expect(opened).toBe(true);
    expect(named.map((option) => option.label)).toStrictEqual(["Asha Rao"]);
  });
});
