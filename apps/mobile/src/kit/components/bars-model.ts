import { barStack, barWindow } from "@centraid/design/blocks";

export interface BarDatum {
  key: string;
  succeeded: number;
  failed: number;
  label: string;
}

export type BarHeight = `${number}%`;

export interface BarColumn {
  key: string;
  label: string;
  succeededHeight: BarHeight | null;
  failedHeight: BarHeight | null;
  hasFailed: boolean;
}

export function barColumn(datum: BarDatum): BarColumn {
  const stack = barStack({ fail: datum.failed, ok: datum.succeeded });
  return {
    failedHeight: stack.hasFail ? `${stack.fail}%` : null,
    hasFailed: stack.hasFail,
    key: datum.key,
    label: datum.label,
    succeededHeight: stack.ok > 0 ? `${stack.ok}%` : null,
  };
}

export function barColumns(
  data: readonly BarDatum[],
  count: number
): readonly BarColumn[] {
  return barWindow(data, count).map(barColumn);
}
