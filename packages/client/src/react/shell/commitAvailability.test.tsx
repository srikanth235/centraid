import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Button from "../ui/Button.js";
import {
  commitAvailabilityFor,
  CommitAvailabilityProvider,
  OFFLINE_COMMIT_REASON,
} from "./commitAvailability.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

/** The shell is offline; anything inside is rendered as it would be then. */
function offline(node: JSX.Element): HTMLDivElement {
  return mount(
    <CommitAvailabilityProvider value={commitAvailabilityFor("down")}>
      {node}
    </CommitAvailabilityProvider>
  );
}

const button = (el: HTMLDivElement): HTMLButtonElement =>
  el.querySelector("button") as HTMLButtonElement;

describe("shell/commitAvailability", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe(commitAvailabilityFor, () => {
    it("blocks only on a KNOWN outage", () => {
      expect(commitAvailabilityFor("down")).toStrictEqual({
        blocked: true,
        reason: OFFLINE_COMMIT_REASON,
      });
    });

    it("allows commits while up, unknown, or not yet reported", () => {
      for (const status of ["up", "unknown", undefined] as const)
        expect(commitAvailabilityFor(status).blocked).toBe(false);
    });
  });

  describe("the commit control disables itself while offline", () => {
    it("refuses a primary — the filled ink IS the commit control", () => {
      const onClick = vi.fn<() => void>();
      const el = offline(
        <Button label="Save" onClick={onClick} variant="primary" />
      );
      act(() => button(el).click());
      expect(onClick).not.toHaveBeenCalled();
      expect(button(el).getAttribute("aria-disabled")).toBe("true");
    });

    it("carries the reason as visible inline text AND an accessible description — never a tooltip", () => {
      const el = offline(<Button label="Save" variant="primary" />);
      expect(button(el).title).toBeFalsy();
      const describedBy = button(el).getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const reasonEl = el.querySelector(
        `#${CSS.escape(describedBy as string)}`
      );
      expect(reasonEl?.textContent).toBe(OFFLINE_COMMIT_REASON);
      // Visible, not screen-reader-only — the brief bars a disabled commit
      // from stating its reason only in a tooltip.
      expect(reasonEl?.tagName).toBe("SPAN");
      expect(el.querySelector('[style*="clip"]')).toBeNull();
    });

    it("stays FOCUSABLE so a keyboard reader can hear why", () => {
      // `aria-disabled`, not `disabled`: a `disabled` button is skipped by the
      // tab order and its description is never announced.
      expect(
        button(offline(<Button label="Save" variant="primary" />)).disabled
      ).toBe(false);
    });

    it("recedes with the leaf ink token, never a container opacity", () => {
      const el = offline(<Button label="Save" variant="primary" />);
      // The rule is `.btn[aria-disabled='true'] { color: var(--text-disabled) }`
      // in Button.module.css — nothing sets an inline opacity here.
      expect(button(el).style.opacity).toBe("");
      expect(el.querySelector('[style*="opacity"]')).toBeNull();
    });

    it("leaves a non-commit control alone", () => {
      const onClick = vi.fn<() => void>();
      const el = offline(<Button label="Cancel" onClick={onClick} />);
      act(() => button(el).click());
      expect(onClick).toHaveBeenCalledOnce();
      expect(button(el).getAttribute("aria-disabled")).toBeNull();
    });

    it("honours an explicit `commit` on a control that is not the primary", () => {
      const onClick = vi.fn<() => void>();
      const el = offline(
        <Button commit label="Delete" onClick={onClick} variant="destructive" />
      );
      act(() => button(el).click());
      expect(onClick).not.toHaveBeenCalled();
    });

    it("lets a primary that only navigates opt OUT", () => {
      const onClick = vi.fn<() => void>();
      const el = offline(
        <Button
          commit={false}
          label="Next"
          onClick={onClick}
          variant="primary"
        />
      );
      act(() => button(el).click());
      expect(onClick).toHaveBeenCalledOnce();
    });

    it("keeps a screen's own `disabled` as the reason when it is already refusing", () => {
      const el = offline(
        <Button
          disabled
          label="Save"
          title="Pick a file first"
          variant="primary"
        />
      );
      expect(button(el).disabled).toBe(true);
      expect(button(el).title).toBe("Pick a file first");
      expect(button(el).getAttribute("aria-describedby")).toBeNull();
    });
  });

  describe("with no provider and while online", () => {
    it("commits normally outside a provider — the default is never 'refuse'", () => {
      const onClick = vi.fn<() => void>();
      const el = mount(
        <Button label="Save" onClick={onClick} variant="primary" />
      );
      act(() => button(el).click());
      expect(onClick).toHaveBeenCalledOnce();
      expect(button(el).getAttribute("aria-disabled")).toBeNull();
    });

    it("commits normally while the gateway is up", () => {
      const onClick = vi.fn<() => void>();
      const el = mount(
        <CommitAvailabilityProvider value={commitAvailabilityFor("up")}>
          <Button label="Save" onClick={onClick} variant="primary" />
        </CommitAvailabilityProvider>
      );
      act(() => button(el).click());
      expect(onClick).toHaveBeenCalledOnce();
    });
  });
});
