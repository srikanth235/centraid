import { useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { uniformModel } from "../../_shared/virtual-window.ts";
import {
  useMeasuredBlockHeight,
  useScrollHost,
  useVirtualWindow,
  VirtualSpacer,
} from "../../_shared/VirtualWindow.tsx";

const ROW_RUNG_FALLBACK = 44;

export interface RowPosition {
  index: number;
  setSize: number;
}

export interface WindowedRowsProps<T> {
  rows: readonly T[];
  className?: string;
  fallbackHeight?: number;
  children: (row: T, position: RowPosition) => ReactNode;
}

export function WindowedRows<T>(props: WindowedRowsProps<T>): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollRef = useScrollHost(listRef);
  const rowHeight = useMeasuredBlockHeight(
    listRef,
    props.fallbackHeight ?? ROW_RUNG_FALLBACK
  );
  const count = props.rows.length;
  const model = useMemo(
    () => uniformModel(count, rowHeight),
    [count, rowHeight]
  );
  const slice = useVirtualWindow({ model, scrollRef, listRef });

  return (
    <ul className={props.className} ref={listRef}>
      <VirtualSpacer height={slice.padStart} as="li" />
      {props.rows
        .slice(slice.start, slice.end)
        .map((row, offset) =>
          props.children(row, { index: slice.start + offset, setSize: count })
        )}
      <VirtualSpacer height={slice.padEnd} as="li" />
    </ul>
  );
}
