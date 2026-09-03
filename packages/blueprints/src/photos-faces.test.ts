// @vitest-environment jsdom
// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- issue #711: browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (see photos-media.test.ts's own note)
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// oxlint-disable-next-line vitest/prefer-import-in-mock -- see header
vi.mock("../apps/photos/outcomes.ts", () => ({
  act: (action: string, input: unknown) => {
    acts.push({ action, input });
    return Promise.resolve({ status: "executed" });
  },
  narrate: () => true,
}));

const FACES_PATH = "../apps/photos/faces.ts";
const importFaces = (relativePath: string) => import(relativePath);

interface StubRegion {
  region_id: string;
  confirmed?: boolean;
  person_name?: string | null;
  confidence?: number | null;
  party_id?: string | null;
}

let acts: Array<{ action: string; input: unknown }> = [];

function stubCentraid(regions: StubRegion[]): void {
  vi.stubGlobal("window", {
    ...window,
    centraid: {
      read: () =>
        Promise.resolve({
          regions,
          people: [{ party_id: "party-ana", name: "Ana" }],
        }),
    },
  });
}

describe("photos faces mini-list", () => {
  beforeEach(() => {
    vi.resetModules();
    acts = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rule 1: never renders confidence as a percentage", async () => {
    stubCentraid([
      {
        region_id: "r1",
        party_id: "party-ana",
        person_name: "Ana",
        confidence: 0.92, // a similarity score — must never surface as 92%
      },
      {
        region_id: "r2",
        party_id: "party-ana",
        person_name: "Ana",
        confidence: 0.5,
      },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    expect(host.textContent).not.toMatch(/%/u);
    expect(host.textContent).toMatch(/1 matching face/u);
  });

  it("rule 2: shows exactly one unconfirmed proposal at a time", async () => {
    stubCentraid([
      { region_id: "r1", party_id: null, person_name: null },
      { region_id: "r2", party_id: null, person_name: null },
      { region_id: "r3", party_id: null, person_name: null },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    expect(host.querySelectorAll("select")).toHaveLength(1);
    expect(host.textContent).toMatch(/2 more faces to review/u);
  });

  it("Skip moves to the next face without writing anything", async () => {
    stubCentraid([
      { region_id: "r1", party_id: null, person_name: null },
      { region_id: "r2", party_id: null, person_name: null },
    ]);
    const { renderFaces } = (await importFaces(FACES_PATH)) as FacesModule;
    const host = document.createElement("div");
    const note = document.createElement("p");
    await renderFaces(host, "asset-1", note);
    const skipBtn = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Skip"
    );
    skipBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(acts).toHaveLength(0);
    expect(host.dataset.faceIndex).toBe("1");
  });
});
