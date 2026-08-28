// Shared mount + door stubs for the web grant-sheet suites (#825).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { GrantDoor } from "./grant-door.ts";
import type { GrantRecord, GrantSubjectOffer } from "./grant-plane.ts";
import { GrantSheet } from "./GrantSheet.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export const OFFERS: GrantSubjectOffer[] = [
  { subjectType: "core.document", capabilities: ["view"] },
  { subjectType: "media.asset", capabilities: ["view"] },
  { subjectType: "tally.group", capabilities: ["view", "edit"] },
];

export const GROUP_SUBJECT = {
  subjectType: "tally.group",
  subjectId: "group-1",
  label: "Ski trip",
};

export const AUDIENCES = [
  { kind: "party" as const, id: "party-priya", label: "Priya" },
  { kind: "party" as const, id: "party-ravi", label: "Ravi" },
];

export function standingGrant(
  overrides: Partial<GrantRecord> = {}
): GrantRecord {
  return {
    grantId: "grant-1",
    audience: { kind: "party", id: "party-priya" },
    subjectType: "core.document",
    subjectId: "doc-1",
    capability: "view",
    grantedAt: "2026-08-01T10:00:00.000Z",
    revokedAt: null,
    grantedBy: "party-owner",
    maxSizeBytes: null,
    fulfillment: [
      {
        peerVaultId: "vault-priya",
        state: "delivered",
        updatedAt: "2026-08-01T10:00:01.000Z",
        detail: null,
      },
    ],
    ...overrides,
  };
}

export function stubDoor(overrides: Partial<GrantDoor> = {}): GrantDoor {
  return {
    subjects: () => Promise.resolve({ readable: true, offers: OFFERS }),
    forParty: () => Promise.resolve({ known: true, channel: null, grants: [] }),
    forAudience: () => Promise.resolve({ known: true, grants: [] }),
    forSubject: () => Promise.resolve([]),
    create: () => Promise.resolve({ ok: true, outcome: "created" as const }),
    revoke: () => Promise.resolve({ ok: true, message: "no longer shared" }),
    ...overrides,
  };
}

let root: Root | undefined;

export function buttons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll("button")];
}

export function pressing(
  container: HTMLElement,
  label: string
): HTMLButtonElement {
  const found = buttons(container).find(
    (button) => button.textContent?.trim() === label
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

/**
 * Mount the sheet and record what it SAYS rather than which functions ran:
 * the status line is the sheet's one feedback channel, so the list of
 * sentences that reached it is the observable outcome under test.
 */
export async function mount(
  props: Partial<Parameters<typeof GrantSheet>[0]> = {}
): Promise<{ container: HTMLElement; status: string[] }> {
  const container = document.createElement("div");
  document.body.append(container);
  const status: string[] = [];
  const onStatus = (message: string): void => {
    status.push(message);
  };
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(GrantSheet, {
        open: true,
        onClose: () => undefined,
        audiences: AUDIENCES,
        subjects: [
          {
            subjectType: "core.document",
            subjectId: "doc-1",
            label: "Trip plan",
          },
        ],
        onStatus,
        door: stubDoor(),
        ...props,
      })
    );
  });
  return { container, status };
}

export function unmountSheet(): void {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
}
