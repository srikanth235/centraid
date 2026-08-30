// @vitest-environment jsdom
// jsdom lays nothing out, so the two numbers a virtualizer reads — the
// scroller's height and where the list sits inside it — are installed on the
// fixture rather than measured.
import { act, useRef } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { uniformModel, virtualItemAria } from "./virtual-window.ts";
import {
  useVirtualWindow,
  virtualBlockProps,
  VirtualSpacer,
  useScrollHost,
} from "./VirtualWindow.tsx";

const COUNT = 500;
const ROW = 40;
const VIEWPORT = 400;

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;

function makeScroller(): HTMLDivElement {
  const scroller = document.createElement("div");
  scroller.dataset.scrollHost = "";
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT,
  });
  scroller.getBoundingClientRect = (): DOMRect =>
    ({ top: 0, left: 0, height: VIEWPORT, width: 600 }) as DOMRect;
  return scroller;
}

function List({ scroller }: { scroller: HTMLElement }): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollRef = useScrollHost(listRef);
  const model = uniformModel(COUNT, ROW);
  // No overscan: the assertions are about the window itself, not the cushion.
  const slice = useVirtualWindow({ model, scrollRef, listRef, overscan: 0 });
  void scroller;
  return (
    <ul ref={listRef}>
      <VirtualSpacer height={slice.padStart} as="li" />
      {Array.from({ length: slice.end - slice.start }, (_, offset) => {
        const index = slice.start + offset;
        return (
          <li
            key={index}
            {...virtualBlockProps(index)}
            {...virtualItemAria(index, COUNT)}
          >
            <button type="button" id={`row-${index}`}>
              Row {index}
            </button>
          </li>
        );
      })}
      <VirtualSpacer height={slice.padEnd} as="li" />
    </ul>
  );
}

/** The offset both fixture stubs read. */
let offset = 0;

function mount(): { scroller: HTMLElement; list: () => HTMLElement } {
  offset = 0;
  host = document.createElement("div");
  const scroller = makeScroller();
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => offset,
  });
  host.append(scroller);
  document.body.append(host);
  const mountPoint = document.createElement("div");
  scroller.append(mountPoint);
  root = createRoot(mountPoint);
  act(() => root!.render(<List scroller={scroller} />));
  const list = () => scroller.querySelector("ul") as HTMLElement;
  // A real layout moves the list's box UP as the pane scrolls; without this
  // the hook reads the list as starting at the scroll offset — nothing moves.
  list().getBoundingClientRect = (): DOMRect =>
    ({ top: -offset, left: 0, height: 0, width: 600 }) as DOMRect;
  return { scroller, list };
}

function scrollTo(scroller: HTMLElement, top: number): void {
  offset = top;
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
}

const mountedIndexes = (list: HTMLElement): number[] =>
  [...list.querySelectorAll<HTMLElement>("[data-vindex]")].map((el) =>
    Number(el.dataset.vindex)
  );

describe("a list whose cost is its viewport", () => {
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it("mounts a viewport's worth of a 500-block list, not the list", () => {
    const { list } = mount();
    const mounted = mountedIndexes(list());
    expect(mounted[0]).toBe(0);
    // 400px of viewport at 40px a row is ten rows plus the partial one.
    expect(mounted).toHaveLength(11);
  });

  it("moves the window with the scroll, and keeps the spacers exact", () => {
    const { scroller, list } = mount();
    scrollTo(scroller, 4_000);
    const mounted = mountedIndexes(list());
    expect(mounted[0]).toBe(100);
    expect(mounted.at(-1)).toBe(110);
    const spacers = [
      ...list().querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
    ].map((el) => el.style.height);
    // 100 blocks above, 389 below — the full 500 either side of the window.
    expect(spacers).toStrictEqual(["4000px", "15560px"]);
  });

  // Unmounting the element focus is inside drops focus to `<body>`, and
  // nothing on screen says so.
  it("keeps the focused block mounted after scrolling far past it", () => {
    const { scroller, list } = mount();
    const target = list().querySelector<HTMLButtonElement>("#row-3")!;
    act(() => target.focus());
    expect(document.activeElement).toBe(target);

    scrollTo(scroller, 8_000);

    const mounted = mountedIndexes(list());
    expect(mounted).toContain(3);
    expect(mounted).toContain(200);
    expect(document.activeElement).toBe(
      list().querySelector<HTMLButtonElement>("#row-3")
    );
    // Pinned, never relocated: the row is still at its own offset.
    const padStart = list().querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(padStart?.style.height).toBe("120px");
  });

  it("releases the pin once focus leaves the list", () => {
    const { scroller, list } = mount();
    act(() => list().querySelector<HTMLButtonElement>("#row-3")!.focus());
    scrollTo(scroller, 8_000);
    expect(mountedIndexes(list())).toContain(3);

    const outside = document.createElement("button");
    document.body.append(outside);
    act(() => outside.focus());
    scrollTo(scroller, 8_040);

    expect(mountedIndexes(list())).not.toContain(3);
    outside.remove();
  });

  it("states the true size of the set on every mounted row", () => {
    const { scroller, list } = mount();
    scrollTo(scroller, 4_000);
    const first = list().querySelector<HTMLElement>("[data-vindex]")!;
    expect(first.getAttribute("aria-setsize")).toBe(String(COUNT));
    expect(first.getAttribute("aria-posinset")).toBe("101");
  });

  // The renderer soak lane counts exactly these registrations.
  it("leaves no listener and no observer behind on unmount", () => {
    host = document.createElement("div");
    const scroller = makeScroller();
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => offset,
    });
    host.append(scroller);
    document.body.append(host);

    const live = new Set<string>();
    const nativeAdd = scroller.addEventListener.bind(scroller);
    const nativeRemove = scroller.removeEventListener.bind(scroller);
    scroller.addEventListener = ((type: string, fn: EventListener) => {
      live.add(type);
      nativeAdd(type, fn);
    }) as typeof scroller.addEventListener;
    scroller.removeEventListener = ((type: string, fn: EventListener) => {
      live.delete(type);
      nativeRemove(type, fn);
    }) as typeof scroller.removeEventListener;

    let observing = 0;
    class CountingResizeObserver {
      observe(): void {
        observing += 1;
      }
      disconnect(): void {
        observing -= 1;
      }
      unobserve(): void {
        /* the hook disconnects rather than unobserving */
      }
    }
    const previousResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver =
      CountingResizeObserver as unknown as typeof ResizeObserver;

    const mountPoint = document.createElement("div");
    scroller.append(mountPoint);
    root = createRoot(mountPoint);
    act(() => root!.render(<List scroller={scroller} />));
    expect(live.has("scroll")).toBe(true);
    expect(observing).toBe(1);

    act(() => root!.unmount());
    root = undefined;
    globalThis.ResizeObserver = previousResizeObserver;

    expect(live.has("scroll")).toBe(false);
    expect(observing).toBe(0);
  });
});
