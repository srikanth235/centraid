import path from "node:path";
import { pathToFileURL } from "node:url";

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const GRANT_AUDIENCES = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/photos/grant-audiences.ts")
).href;
const SHARED_AUDIENCES = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/grant-audiences.ts")
).href;
const GRANT_GATEWAY = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/grant-gateway.ts")
).href;

const load = (url: string) => import(url);

interface PhotoShareEntry {
  audiences: readonly unknown[];
  open: boolean;
  request: () => void;
  close: () => void;
}

describe("Photos' grant entry, web seat", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    delete (window as { centraid?: unknown }).centraid;
  });

  const press = async (
    centraid: Record<string, unknown>
  ): Promise<{ said: string[]; opened: boolean }> => {
    (window as { centraid?: unknown }).centraid = centraid;
    const { usePhotoShare } = (await load(GRANT_AUDIENCES)) as {
      usePhotoShare: (refuse: (message: string) => void) => PhotoShareEntry;
    };
    const said: string[] = [];
    const seen: PhotoShareEntry[] = [];
    const Probe = (): null => {
      seen.push(usePhotoShare((message) => said.push(message)));
      return null;
    };
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(Probe));
    });
    await act(async () => {
      seen.at(-1)?.request();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return { said, opened: Boolean(seen.at(-1)?.open) };
  };

  const grants = { create: () => Promise.resolve({}) };

  it("opens over a roster that named somebody, silently", async () => {
    const { said, opened } = await press({
      grants,
      scopes: [],
      shareCircles: () => Promise.resolve([]),
      shareTargets: () =>
        Promise.resolve([{ partyId: "party-asha", label: "Asha" }]),
    });
    expect(said).toStrictEqual([]);
    expect(opened).toBe(true);
  });

  it("says NOBODY YET for a roster that answered, and answered empty", async () => {
    const { NOBODY_TO_SHARE_WITH } = (await load(SHARED_AUDIENCES)) as {
      NOBODY_TO_SHARE_WITH: string;
    };
    const { said, opened } = await press({
      grants,
      scopes: [],
      shareCircles: () => Promise.resolve([]),
      shareTargets: () => Promise.resolve([]),
    });
    expect(said).toStrictEqual([NOBODY_TO_SHARE_WITH]);
    expect(opened).toBe(false);
  });

  it("says the READ FAILED when the roster could not be read — never 'nobody'", async () => {
    const { NOBODY_TO_SHARE_WITH, ROSTER_UNREADABLE } = (await load(
      SHARED_AUDIENCES
    )) as { NOBODY_TO_SHARE_WITH: string; ROSTER_UNREADABLE: string };
    const { said, opened } = await press({
      grants,
      scopes: [],
      shareCircles: () => Promise.resolve([]),
      shareTargets: () => Promise.reject(new Error("gateway gone")),
    });
    expect(said).toStrictEqual([ROSTER_UNREADABLE]);
    expect(said).not.toContain(NOBODY_TO_SHARE_WITH);
    expect(opened).toBe(false);
  });

  it("names the missing bridge, not the roster, on a host with no grant plane", async () => {
    const { GRANTS_UNAVAILABLE_HERE } = (await load(GRANT_GATEWAY)) as {
      GRANTS_UNAVAILABLE_HERE: string;
    };
    const { said, opened } = await press({
      scopes: [],
      shareCircles: () => Promise.resolve([]),
      shareTargets: () => Promise.resolve([]),
    });
    expect(said).toStrictEqual([GRANTS_UNAVAILABLE_HERE]);
    expect(opened).toBe(false);
  });
});
// @vitest-environment jsdom
