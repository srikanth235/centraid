import { describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import type { CentraidHost } from "./host.js";
import {
  closePopover,
  el,
  fmtBytes,
  h,
  isPopoverOpen,
  onDataChange,
  openPopover,
  popItem,
  renderAttachments,
  subscribeReadUpdates,
} from "./index.js";

function withHost(host: CentraidHost): () => void {
  (globalThis as { centraid?: CentraidHost }).centraid = host;
  return () => {
    delete (globalThis as { centraid?: CentraidHost }).centraid;
  };
}

describe("element layer", () => {
  it("registers no custom elements — the barrel is plain functions", () => {
    for (const tag of [
      "kit-avatar",
      "kit-meter",
      "kit-skeleton",
      "kit-status-line",
    ]) {
      expect(customElements.get(tag), tag).toBeUndefined();
    }
  });

  it("h/el build DOM", () => {
    const n = h("div", { class: "x", onclick: () => {} }, "hi", null, false, [
      "a",
    ]);
    expect(n.className).toBe("x");
    expect(n.textContent).toBe("hia");
    expect(el('<span id="q">z</span>').id).toBe("q");
  });

  it("renderAttachments renders tiles; onRemove:null omits the control", () => {
    const strip = document.createElement("div");
    const list = [
      {
        attachment_id: "a1",
        media_type: "image/png",
        content_uri: "x.png",
        byte_size: 2048,
      },
      {
        attachment_id: "a2",
        media_type: "application/pdf",
        content_uri: "x.pdf",
        title: "Doc",
      },
    ];
    renderAttachments(strip, list, null);
    expect(strip.querySelectorAll(".kit-attach-tile")).toHaveLength(2);
    expect(strip.querySelector(".kit-attach-remove")).toBeNull();
    renderAttachments(strip, list, async () => undefined, {
      onZoom: () => {},
    });
    expect(strip.querySelectorAll(".kit-attach-remove")).toHaveLength(2);
    expect(strip.querySelector("img.kit-attach-zoom")).toBeTruthy();
    expect(strip.querySelector(".kit-attach-meta")?.textContent).toBe("2.0 KB");
  });

  it("renderAttachments swaps vault blob refs for the host's authed URLs", async () => {
    const blobUrl = vi.fn<NonNullable<CentraidHost["blobUrl"]>>(
      async (pathname) => `blob:${pathname}`
    );
    const restore = withHost({ blobUrl });
    try {
      const strip = document.createElement("div");
      document.body.appendChild(strip);
      renderAttachments(
        strip,
        [
          {
            attachment_id: "a1",
            media_type: "image/png",
            content_uri: "/centraid/_vault/blobs/c1",
          },
          {
            attachment_id: "a2",
            media_type: "application/pdf",
            content_uri: "/centraid/_vault/blobs/c2",
          },
        ],
        null
      );
      await vi.waitFor(() =>
        expect(strip.querySelector("a")?.getAttribute("href")).toBe(
          "blob:/centraid/_vault/blobs/c2"
        )
      );
      expect(strip.querySelector("img")?.getAttribute("src")).toBe(
        "blob:/centraid/_vault/blobs/c1"
      );
      strip.remove();
    } finally {
      restore();
    }
  });

  it("popover opens, reports, closes", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    expect(isPopoverOpen()).toBe(false);
    openPopover(anchor, (box) =>
      box.appendChild(popItem("Move", () => {}, { dotColor: "red" }))
    );
    expect(isPopoverOpen()).toBe(true);
    const box = document.querySelector(".kit-popover");
    expect(box).toBeTruthy();
    expect(box?.querySelector(".kit-popover-item")).toBeTruthy();
    expect(box?.querySelector(".kit-dotmini")).toBeTruthy();
    closePopover();
    expect(isPopoverOpen()).toBe(false);
    expect(document.querySelector(".kit-popover")).toBeNull();
  });

  it("popover form options: className, role, focus, Escape-inside", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    openPopover(
      anchor,
      (box) => {
        box.appendChild(document.createElement("input"));
      },
      { focus: true, className: "t-when", role: "dialog" }
    );
    const box = document.querySelector(".kit-popover");
    expect(box?.classList.contains("t-when")).toBe(true);
    expect(box?.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(box?.querySelector("input"));
    box?.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      })
    );
    expect(isPopoverOpen()).toBe(false);
  });

  it("fmtBytes labels", () => {
    expect(fmtBytes(0)).toBe("");
    expect(fmtBytes(0, "—")).toBe("—");
    expect(fmtBytes(500)).toBe("500 B");
    expect(fmtBytes(1024 * 1024 * 1.3)).toBe("1.3 MB");
  });

  it("live reads apply their awaited current value once and forward only reruns", async () => {
    const listeners = new Set<(value: string) => void>();
    const read = Promise.resolve("current") as Promise<string> & {
      subscribe?: (listener: (value: string) => void) => () => void;
    };
    read.subscribe = (listener) => {
      listeners.add(listener);
      void read.then(listener);
      return () => listeners.delete(listener);
    };
    const updates: string[] = [];
    const subscription = subscribeReadUpdates<string>(read, (value) =>
      updates.push(value)
    );

    await expect(read).resolves.toBe("current");
    await Promise.resolve();
    expect(subscription.managed).toBe(true);
    expect(updates).toStrictEqual([]);

    for (const listener of listeners) listener("rerun");
    expect(updates).toStrictEqual(["rerun"]);
    subscription.unsubscribe();
    expect(listeners.size).toBe(0);
  });

  it("live reads do not let a late initial result overwrite a newer subscription value", async () => {
    let resolveInitial: (value: string) => void = () => {};
    const listeners = new Set<(value: string) => void>();
    const read = new Promise<string>((resolve) => {
      resolveInitial = resolve;
    }) as Promise<string> & {
      subscribe?: (listener: (value: string) => void) => () => void;
    };
    read.subscribe = (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const updates: string[] = [];
    const subscription = subscribeReadUpdates<string>(read, (value) =>
      updates.push(value)
    );

    for (const listener of listeners) listener("fresh");
    resolveInitial("stale");
    await read;
    await Promise.resolve();
    await Promise.resolve();

    expect(updates).toStrictEqual(["fresh"]);
    subscription.unsubscribe();
  });

  it("data-change debounce preserves every distinct intent settlement", () => {
    useFakeClock();
    let listener: ((detail: Record<string, unknown>) => void) | undefined;
    const restore = withHost({
      onChange(next) {
        listener = next as (detail: Record<string, unknown>) => void;
        return () => {
          listener = undefined;
        };
      },
    });
    const updates: Array<{ intentId?: string; intentState?: string }> = [];
    const stop = onDataChange(
      ["schedule.task"],
      (detail) => updates.push(detail),
      { debounceMs: 10 }
    );
    listener?.({
      tables: ["schedule.task"],
      source: "overlay",
      intentId: "intent-a",
      intentState: "executed",
    });
    listener?.({
      tables: ["schedule.task"],
      source: "overlay",
      intentId: "intent-b",
      intentState: "denied",
    });
    vi.advanceTimersByTime(10);

    expect(
      updates.map(({ intentId, intentState }) => ({ intentId, intentState }))
    ).toStrictEqual([
      { intentId: "intent-a", intentState: "executed" },
      { intentId: "intent-b", intentState: "denied" },
    ]);
    stop();
    restore();
  });

  it("plain Promise reads retain the compatibility path", () => {
    const updates: unknown[] = [];
    const subscription = subscribeReadUpdates(
      Promise.resolve("current"),
      (value: unknown) => updates.push(value)
    );
    expect(subscription.managed).toBe(false);
    subscription.unsubscribe();
    expect(updates).toStrictEqual([]);
  });
});
// @vitest-environment jsdom
