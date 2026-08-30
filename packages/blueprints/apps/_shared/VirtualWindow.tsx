// Pins the focused block: unmounting a focused element drops focus to `<body>`.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { modelCount, virtualSlice, wholeSlice } from "./virtual-window.ts";
import type { HeightModel, VirtualSlice } from "./virtual-window.ts";

export const VIRTUAL_INDEX_ATTR = "data-vindex";

export const VIRTUALIZE_FROM = 60;

const DEFAULT_OVERSCAN = 800;

export interface VirtualWindowOptions {
  model: HeightModel;
  scrollRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
  overscan?: number;
  pinned?: readonly number[];
  threshold?: number;
}

const NO_PINS: readonly number[] = [];

export function useVirtualWindow(options: VirtualWindowOptions): VirtualSlice {
  const {
    model,
    scrollRef,
    listRef,
    overscan = DEFAULT_OVERSCAN,
    pinned = NO_PINS,
    threshold = VIRTUALIZE_FROM,
  } = options;
  const count = modelCount(model);
  const windowed = count >= threshold;

  // Tracked, not derived: `document.activeElement` is gone by render time.
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewport: 0 });

  const measure = useCallback((): void => {
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return;
    // The list rarely starts at the top of its scroller; measure the gap.
    const listTop =
      list.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const next = {
      scrollTop: scroller.scrollTop - listTop,
      viewport: scroller.clientHeight,
    };
    setMetrics((previous) =>
      previous.scrollTop === next.scrollTop &&
      previous.viewport === next.viewport
        ? previous
        : next
    );
  }, [scrollRef, listRef]);

  // Layout, not passive: decided before paint, or the list flashes.
  useLayoutEffect(() => {
    if (!windowed) return;
    measure();
  }, [windowed, measure, count]);

  useEffect(() => {
    if (!windowed) return undefined;
    const scroller = scrollRef.current;
    const list = listRef.current;
    if (!scroller || !list) return undefined;

    const onScroll = (): void => measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });

    let resize: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      resize = new ResizeObserver(() => measure());
      resize.observe(scroller);
    }

    const onFocusIn = (event: Event): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const block = target.closest(`[${VIRTUAL_INDEX_ATTR}]`);
      const raw = block?.getAttribute(VIRTUAL_INDEX_ATTR);
      setFocusedIndex(raw === null || raw === undefined ? null : Number(raw));
    };
    // `focusout` fires before the next `focusin`, so focus can MOVE between
    // two blocks without the outgoing one unmounting mid-transition.
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      if (next instanceof Node && list.contains(next)) return;
      setFocusedIndex(null);
    };
    list.addEventListener("focusin", onFocusIn);
    list.addEventListener("focusout", onFocusOut);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resize?.disconnect();
      list.removeEventListener("focusin", onFocusIn);
      list.removeEventListener("focusout", onFocusOut);
    };
  }, [windowed, measure, scrollRef, listRef]);

  const pins = useMemo(
    () => (focusedIndex === null ? pinned : [...pinned, focusedIndex]),
    [pinned, focusedIndex]
  );

  return useMemo(
    () =>
      windowed
        ? virtualSlice({
            model,
            scrollTop: metrics.scrollTop,
            viewport: metrics.viewport,
            overscan,
            pinned: pins,
          })
        : wholeSlice(model),
    [windowed, model, metrics.scrollTop, metrics.viewport, overscan, pins]
  );
}

/** `as="li"` is not decoration: a stray `<div>` in a `<ul>` is invalid markup
 *  and stands where a row's `:last-child` rule expects a row. */
export function VirtualSpacer({
  height,
  as = "div",
}: {
  height: number;
  as?: "div" | "li";
}): ReactNode {
  if (height <= 0) return null;
  const style: CSSProperties = { height: `${height}px`, flex: "0 0 auto" };
  return as === "li" ? (
    <li aria-hidden="true" style={style} />
  ) : (
    <div aria-hidden="true" style={style} />
  );
}

export function virtualBlockProps(index: number): {
  [VIRTUAL_INDEX_ATTR]: string;
} {
  return { [VIRTUAL_INDEX_ATTR]: String(index) };
}

export function useMeasuredBlockHeight(
  listRef: RefObject<HTMLElement | null>,
  fallback: number,
  options: { selector?: string } = {}
): number {
  const selector = options.selector ?? `[${VIRTUAL_INDEX_ATTR}]`;
  const [height, setHeight] = useState(fallback);
  // Writes state ONLY when the ROUNDED height moved — otherwise this is a
  // measure/paint/measure loop.
  useLayoutEffect(() => {
    const block = listRef.current?.querySelector<HTMLElement>(selector);
    if (!block) return;
    const measured = Math.round(block.getBoundingClientRect().height);
    if (measured > 0 && measured !== height) setHeight(measured);
  }, [listRef, selector, height]);
  return height;
}

/** The pane declares itself: an ancestor walk for a scrolling `overflow`
 *  forces a style recalculation and guesses wrong under `overflow: hidden`. */
export const SCROLL_HOST_ATTR = "data-scroll-host";

export function useScrollHost(
  listRef: RefObject<HTMLElement | null>
): RefObject<HTMLElement | null> {
  const ref = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    ref.current =
      listRef.current?.closest<HTMLElement>(`[${SCROLL_HOST_ATTR}]`) ?? null;
  });
  return ref;
}
