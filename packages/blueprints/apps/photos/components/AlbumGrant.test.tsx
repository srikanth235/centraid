// @vitest-environment jsdom
// SHARING AN ALBUM, END TO END INSIDE THE SEAT (#825).
//
// The e2e capture proves this in a real browser; this suite proves the same
// path where it can run on every push — the shipped album bar, the shipped
// grant kit, the shipped roster mapping, and only the host bridge stubbed.
// Nothing between the press and the recorded grant is reimplemented here, so
// a regression in any of those three files fails this test rather than
// passing it with a mock.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setStatusSink } from "../outcomes.ts";
import { AlbumBar } from "./AlbumBar.tsx";

interface GrantCreateRequest {
  audienceKind: string;
  audienceId: string;
  subjectType: string;
  subjectId: string;
  capability: string;
  subjectLabel?: string;
}

let created: GrantCreateRequest[] = [];
let status: string[] = [];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** The host bridge, as the shell publishes it — nothing above it is stubbed. */
function stubHost(): void {
  (window as unknown as { centraid: unknown }).centraid = {
    scopes: [{ id: "", label: "Library", personal: true, canWrite: true }],
    shareTargets: () =>
      Promise.resolve([
        { partyId: "party-priya", label: "Priya", vaultId: "vault-priya" },
      ]),
    shareCircles: () => Promise.resolve([]),
    grants: {
      // The DECLARED registry: an album answers `view` and nothing else.
      subjects: () =>
        Promise.resolve({
          subjects: [
            { subjectType: "core.collection", capabilities: ["view"] },
            { subjectType: "core.document", capabilities: ["view", "edit"] },
          ],
        }),
      // Linked, because since #903 that is the only person a grant can name.
      forParty: () =>
        Promise.resolve({
          channel: { state: "live", vaultId: "vault-priya" },
          grants: [],
        }),
      forAudience: () => Promise.resolve({ grants: [] }),
      forSubject: () => Promise.resolve({ grants: [] }),
      create: (request: GrantCreateRequest) => {
        created.push(request);
        return Promise.resolve({ outcome: "created" });
      },
      revoke: () => Promise.resolve({ message: "no longer shared" }),
    },
  };
}

async function mount(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AlbumBar
        albumId="alb-cornwall"
        title="Cornwall 2024"
        renaming={false}
        canWrite
        onBack={() => {}}
        onStartRename={() => {}}
        onRenameSubmit={() => {}}
        onRenameCancel={() => {}}
        onDelete={() => {}}
      />
    );
  });
}

function button(name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name
  );
}

async function press(name: string): Promise<void> {
  const target = button(name);
  expect(target, name).toBeDefined();
  await act(async () => {
    target!.click();
  });
}

describe("an album shares through the one grant kit", () => {
  beforeEach(() => {
    created = [];
    status = [];
    stubHost();
    setStatusSink((note) => {
      status.push(note ? note.text : "");
    });
    // jsdom does not implement the dialog's two modal methods at all; the
    // element is otherwise real, so they are defined rather than stubbed over.
    for (const method of ["showModal", "close"] as const)
      Object.defineProperty(HTMLDialogElement.prototype, method, {
        configurable: true,
        value: () => {},
      });
  });
  afterEach(() => {
    root.unmount();
    container.remove();
    setStatusSink(null);
  });

  it("records the album as a core.collection view grant, named by its title", async () => {
    await mount();
    await press("Share");
    // The registry answers one verb for an album, so one verb is drawn: album
    // co-contribution is a deferred v1 non-goal, not a hidden control.
    expect(button("Can view")).toBeDefined();
    expect(button("Can edit")).toBeUndefined();
    expect(container.textContent).toContain("Cornwall 2024");
    expect(container.textContent).toContain(
      "Cornwall 2024 is not shared with anyone yet."
    );

    await press("Share");
    expect(created).toStrictEqual([
      {
        audienceKind: "party",
        audienceId: "party-priya",
        subjectType: "core.collection",
        subjectId: "alb-cornwall",
        capability: "view",
        subjectLabel: "Cornwall 2024",
      },
    ]);
    // The outcome is the FRAME's one status line — the kit paints no toast.
    expect(status).toStrictEqual(["Priya can see it"]);
  });

  it("refuses on the status line when there is nobody to name", async () => {
    (
      window as unknown as { centraid: { shareTargets: () => Promise<[]> } }
    ).centraid.shareTargets = () => Promise.resolve([]);
    await mount();
    await press("Share");
    expect(created).toStrictEqual([]);
    expect(status).toStrictEqual([
      "There is nobody to share with yet — add someone in People first.",
    ]);
    // No sheet opened over an empty picker.
    expect(container.querySelector("dialog")).toBeNull();
  });
});
