// Pure and DOM-free; every answer is O(1) or O(log n), never O(n) per scroll.

export type HeightModel =
  | {
      readonly kind: "uniform";
      readonly count: number;
      readonly height: number;
    }
  /** Length is `count + 1`: the last entry is the total height. */
  | { readonly kind: "measured"; readonly offsets: readonly number[] };

/** `end` is EXCLUSIVE; the pads are the omitted blocks' exact heights. */
export interface VirtualSlice {
  readonly start: number;
  readonly end: number;
  readonly padStart: number;
  readonly padEnd: number;
}

export function uniformModel(count: number, height: number): HeightModel {
  return {
    kind: "uniform",
    count: Math.max(0, Math.floor(count)),
    height: Math.max(1, height),
  };
}

export function measuredModel(heights: readonly number[]): HeightModel {
  const offsets: number[] = [0];
  let running = 0;
  for (const height of heights) {
    running += Math.max(0, height);
    offsets.push(running);
  }
  return { kind: "measured", offsets };
}

export function modelCount(model: HeightModel): number {
  return model.kind === "uniform" ? model.count : model.offsets.length - 1;
}

export function modelOffset(model: HeightModel, index: number): number {
  const count = modelCount(model);
  const clamped = Math.min(Math.max(0, index), count);
  if (model.kind === "uniform") return clamped * model.height;
  return model.offsets[clamped] ?? 0;
}

export function modelTotal(model: HeightModel): number {
  return modelOffset(model, modelCount(model));
}

export function indexAtOffset(model: HeightModel, y: number): number {
  const count = modelCount(model);
  if (count === 0) return 0;
  const target = Math.max(0, y);
  if (model.kind === "uniform")
    return Math.min(count - 1, Math.floor(target / model.height));
  const offsets = model.offsets;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= target) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface SliceInput {
  readonly model: HeightModel;
  readonly scrollTop: number;
  readonly viewport: number;
  readonly overscan: number;
  /** Mounted whatever the window says: unmounting a focused element drops
   *  focus to `<body>` and silently ends keyboard navigation. */
  readonly pinned?: readonly number[];
  /** Assumed while `viewport` is 0. Bounded: a first paint that renders
   *  everything is the bug. */
  readonly fallbackViewport?: number;
}

const DEFAULT_FALLBACK_VIEWPORT = 1200;

/** Pads come from the FINAL range: start + mounted + end is the total. */
export function virtualSlice(input: SliceInput): VirtualSlice {
  const { model, scrollTop, overscan } = input;
  const count = modelCount(model);
  if (count === 0) return { start: 0, end: 0, padStart: 0, padEnd: 0 };

  const viewport =
    input.viewport > 0
      ? input.viewport
      : (input.fallbackViewport ?? DEFAULT_FALLBACK_VIEWPORT);
  const top = scrollTop - overscan;
  const bottom = scrollTop + viewport + overscan;

  let start = indexAtOffset(model, top);
  let end = Math.min(count, indexAtOffset(model, bottom) + 1);
  if (bottom <= 0) end = Math.min(count, 1);

  for (const index of input.pinned ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (index < start) start = index;
    if (index + 1 > end) end = index + 1;
  }
  if (end <= start) end = Math.min(count, start + 1);

  return {
    start,
    end,
    padStart: modelOffset(model, start),
    padEnd: modelTotal(model) - modelOffset(model, end),
  };
}

export function wholeSlice(model: HeightModel): VirtualSlice {
  return { start: 0, end: modelCount(model), padStart: 0, padEnd: 0 };
}

/** The row states the TRUE index and total, never the mounted count. */
export function virtualItemAria(
  index: number,
  count: number
): { "aria-setsize": number; "aria-posinset": number } {
  return { "aria-setsize": count, "aria-posinset": index + 1 };
}

export function virtualRowAria(index: number): { "aria-rowindex": number } {
  return { "aria-rowindex": index + 1 };
}
