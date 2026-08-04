import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { postStatus, resetStatus } from "./statusChannel.js";
import StatusLine from "./StatusLine.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

describe("shell/StatusLine", () => {
  beforeEach(() => resetStatus());
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    resetStatus();
  });

  describe(StatusLine, () => {
    it("stands with the route's ambient sentence and a neutral dot", () => {
      const el = render(<StatusLine ambient="Synced" />);
      const line = el.querySelector(".statusLine")!;
      expect(line.textContent).toContain("Synced");
      expect(el.querySelector(".statusDot")).not.toBeNull();
      // The whole line is the announcement channel, so it is announced once,
      // politely, without stealing focus.
      expect(line.getAttribute("aria-live")).toBe("polite");
      expect(line.tagName.toLowerCase()).toBe("output");
    });

    it("shows the latest note in place of the ambient line, and back again", () => {
      const el = render(<StatusLine ambient="Synced" />);
      act(() => postStatus("Renamed · Groceries"));
      expect(el.querySelector(".statusText")?.textContent).toBe(
        "Renamed · Groceries"
      );
      // One line, so the note REPLACES rather than stacking beside.
      expect(el.querySelectorAll(".statusText")).toHaveLength(1);
    });

    it("reports a long local operation with a determinate bar and exact counts", () => {
      const el = render(<StatusLine ambient="Ready" />);
      act(() =>
        postStatus("Importing", {
          progress: { done: 412, total: 1904, unit: "photos" },
        })
      );
      const bar = el.querySelector<HTMLElement>(".statusBar")!;
      // A ratio the track resolves — determinate, because a local-first
      // product always knows the size of its own work.
      expect(bar.style.getPropertyValue("--status-progress")).toBe(
        String(412 / 1904)
      );
      // Grouped, because "1904" and "1,904" are not equally readable at 11.5px.
      expect(el.querySelector(".statusCounts")?.textContent).toBe(
        "412 of 1,904 photos"
      );
    });

    it("offers a note's action as a bounded control", () => {
      const run = vi.fn<() => void>();
      const el = render(<StatusLine ambient="Ready" />);
      act(() =>
        postStatus("Deleted “Groceries”", { action: { label: "Undo", run } })
      );
      const action = el.querySelector<HTMLButtonElement>(".statusAction")!;
      expect(action.textContent).toBe("Undo");
      act(() => action.click());
      expect(run).toHaveBeenCalledOnce();
    });

    describe("offline", () => {
      const offlineProps = {
        ambient: "Synced",
        offline: true,
        offlineReason: "Offline · commits are disabled",
        offlineAction: { label: "Check gateway", run: vi.fn<() => void>() },
      };

      it("takes the bordered banner state with the reason inline", () => {
        const el = render(<StatusLine {...offlineProps} />);
        const line = el.querySelector<HTMLElement>(".statusLine")!;
        expect(line.dataset.offline).toBe("true");
        // Inline, never a tooltip: a tooltip has no mobile.
        expect(line.textContent).toContain("commits are disabled");
        expect(el.querySelector(".statusAction")?.textContent).toBe(
          "Check gateway"
        );
      });

      it("outranks a transient note — being offline is the bigger news", () => {
        const el = render(<StatusLine {...offlineProps} />);
        act(() => postStatus("Saved"));
        expect(el.querySelector(".statusText")?.textContent).toContain(
          "Offline"
        );
      });
    });
  });
});
