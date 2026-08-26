// `Shared with them`, the phone's half (#825): FIVE STATES, FIVE SENTENCES —
// none borrows another's words. Real component on the shared react-native
// stub (the PeopleKit harness); the grant door is the seam, so what the
// screen SAYS is the observable outcome.
// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  audienceNotKnown,
  GRANTS_UNREADABLE,
  nothingSharedYet,
} from "@centraid/blueprints/apps/_shared/grant-copy";
import type { GrantDoor } from "@centraid/blueprints/apps/_shared/grant-door";
import { GRANTS_UNAVAILABLE_HERE } from "@centraid/blueprints/apps/_shared/grant-gateway";
import type { GrantRecord } from "@centraid/blueprints/apps/_shared/grant-plane";

import PersonGrants from "./PersonGrants";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

// No gateway base by default: tests inject a door to make the plane reachable.
const gatewayBase = vi.hoisted(() => ({ value: "" }));
vi.mock(
  import("../../kit/replica/ReplicaProvider"),
  () =>
    ({
      useReplica: () => ({ gatewayBase: gatewayBase.value }),
    }) as never
);

// The default door would pull the Expo module runtime into plain jsdom;
// every test injects its own door.
vi.mock(
  import("../../kit/share/grants-transport"),
  () => ({ nativeGrantDoor: () => undefined }) as never
);

// The sheet has its own suite (`kit/share/GrantSheet.test.tsx`); here it is a
// recorder, so what this screen HANDS it is observable without native imports.
const sheetProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock(
  import("../../kit/share/GrantSheet"),
  () =>
    ({
      default: (props: Record<string, unknown>) => {
        sheetProps.push(props);
        return null;
      },
    }) as never
);

const posted = vi.hoisted(() => [] as string[]);
vi.mock(
  import("../../kit/components/status-line"),
  () =>
    ({
      postStatus: (message: string) => posted.push(message),
    }) as never
);

const ASHA = "Asha Rao";
const PARTY = "party-asha";

function standingGrant(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    grantId: "grant-1",
    audience: { kind: "party", id: PARTY },
    subjectType: "core.document",
    subjectId: "doc-1",
    capability: "view",
    grantedAt: "2026-08-01T10:00:00.000Z",
    revokedAt: null,
    grantedBy: "party-owner",
    maxSizeBytes: null,
    fulfillment: [],
    ...overrides,
  };
}

function stubDoor(overrides: Partial<GrantDoor> = {}): GrantDoor {
  return {
    subjects: () => Promise.resolve({ readable: true, offers: [] }),
    forParty: () => Promise.resolve({ known: true, channel: null, grants: [] }),
    forAudience: () => Promise.resolve({ known: true, grants: [] }),
    forSubject: () => Promise.resolve([]),
    create: () => Promise.resolve({ ok: true, outcome: "created" as const }),
    revoke: () => Promise.resolve({ ok: true, message: "no longer shared" }),
    ...overrides,
  };
}

let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLElement | undefined;

/** Mount the section and hand back the text it painted. */
async function show(door?: GrantDoor): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      <PersonGrants
        partyId={PARTY}
        personName={ASHA}
        roster={[{ party_id: "party-ravi", name: "Ravi" }]}
        open
        onToggle={() => undefined}
        {...(door ? { door } : {})}
      />
    );
  });
  return container;
}

/** A control by its visible word, or by the hint that names its object —
 *  how the kit tells ten identical `Revoke`s apart (PeopleKit). */
function verb(label: string, hint?: string | null): HTMLButtonElement {
  const found = [...container!.querySelectorAll("button")].find(
    (button) =>
      (hint === undefined ||
        button.dataset.hint === (hint === null ? undefined : hint)) &&
      (button.textContent?.trim() === label ||
        button.getAttribute("aria-label") === label)
  );
  if (!found) throw new Error(`no control labelled ${label}`);
  return found;
}

describe("the person screen's grant dashboard, phone seat", () => {
  beforeEach(() => {
    posted.length = 0;
    sheetProps.length = 0;
    gatewayBase.value = "";
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    container = undefined;
    document.body.replaceChildren();
  });

  it("claims nothing while the read is still in flight", async () => {
    const el = await show(
      stubDoor({
        forParty: () =>
          new Promise(() => {
            // Never settles: the read is still in flight.
          }),
      })
    );
    // The skeleton names the section it stands in; the screen asserts nothing
    // about Asha it has not read.
    expect(el.querySelector('[aria-label="Shared with them"]')).not.toBeNull();
    expect(el.textContent).not.toContain(nothingSharedYet(ASHA));
    expect(el.textContent).not.toContain(audienceNotKnown(ASHA));
  });

  it("names the missing bridge where there is no grant plane to reach", async () => {
    const el = await show();
    expect(el.textContent).toContain(GRANTS_UNAVAILABLE_HERE);
    expect(el.textContent).not.toContain(nothingSharedYet(ASHA));
  });

  it("prints the route's own refusal verbatim, never a local paraphrase", async () => {
    const el = await show(
      stubDoor({
        forParty: () => Promise.reject(new Error("The vault is sealed.")),
      })
    );
    expect(el.textContent).toContain("The vault is sealed.");
    expect(el.textContent).not.toContain(GRANTS_UNREADABLE);
  });

  it("falls back to the kit's sentence when the route sent no words", async () => {
    const el = await show(
      stubDoor({ forParty: () => Promise.reject(new Error("  ")) })
    );
    expect(el.textContent).toContain(GRANTS_UNREADABLE);
  });

  it("says a party this vault never heard of is unknown, not unshared", async () => {
    const el = await show(
      stubDoor({
        forParty: () =>
          Promise.resolve({ known: false, channel: null, grants: [] }),
      })
    );
    expect(el.textContent).toContain(audienceNotKnown(ASHA));
    expect(el.textContent).not.toContain(nothingSharedYet(ASHA));
  });

  it("says nothing is shared only for a read that came back empty", async () => {
    const el = await show(stubDoor());
    expect(el.textContent).toContain(nothingSharedYet(ASHA));
    expect(el.textContent).toContain("Not reached yet");
    expect(el.textContent).toContain("Sharing sends an invitation first.");
  });

  it("reads an unaccepted invitation as pending, never as an error", async () => {
    const el = await show(
      stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            channel: { state: "invited" as const },
            grants: [standingGrant()],
          }),
      })
    );
    expect(el.textContent).toContain("Invitation pending");
    expect(el.textContent).toContain(
      "Sharing waits here until they join with a vault."
    );
    // A pending invitation withholds nothing: its grant is drawn.
    expect(el.textContent).not.toContain(nothingSharedYet(ASHA));
  });

  it("opens the sheet on THIS person, over what the read named", async () => {
    await show(
      stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            channel: { state: "live" as const },
            grants: [standingGrant()],
          }),
      })
    );
    await act(async () => verb("Share").click());
    const handed = sheetProps.at(-1) ?? {};
    // This person is preselected, and she leads the roster.
    expect(handed.audienceId).toBe(PARTY);
    expect((handed.audiences as { label: string }[])[0]?.label).toBe(ASHA);
    expect((handed.subjects as unknown[]).length).toBeGreaterThan(0);
    expect(handed.visible).toBe(true);
  });

  it("revokes only after the confirm, and posts the route's sentence verbatim", async () => {
    const revoked: string[] = [];
    await show(
      stubDoor({
        forParty: () =>
          Promise.resolve({
            known: true,
            channel: { state: "live" as const },
            grants: [standingGrant()],
          }),
        revoke: (grantId) => {
          revoked.push(grantId);
          return Promise.resolve({
            ok: true,
            message: "Asha Rao can no longer open it on her own device.",
          });
        },
      })
    );

    // The row's own Revoke names its object in the hint.
    await act(async () => verb("Revoke", "Revoke document").click());
    // Asking is the whole point of the confirm: nothing revoked yet.
    expect(revoked).toStrictEqual([]);

    // The confirm's Revoke carries no object hint — it is the decision.
    await act(async () => verb("Revoke", null).click());
    expect(revoked).toStrictEqual(["grant-1"]);
    expect(posted).toStrictEqual([
      "Asha Rao can no longer open it on her own device.",
    ]);
  });
});
