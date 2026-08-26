// Cross-seat selection as a pure model (§6). A live selection REPLACES the band
// with five targets in one fixed order, kept here so two surfaces cannot
// disagree. A batch is one member act; one bad item must not strand the rest.

export type SelectionActionId =
  | "favorite"
  | "add-to-album"
  | "share"
  | "download"
  | "trash";

export type SelectionShelfKind = "trash" | "normal";

/** Above the 44 floor: the primary bar while a selection is live. */
export const SELECTION_ACTION_TARGET = 56;

export interface SelectionAction {
  id: SelectionActionId;
  /** Also the caption: icon-only is an unnamed control (§18). */
  label: string;
  icon: string;
  run: () => void;
  disabled: boolean;
  /** Rendered under the bar, never only in an accessibility hint. */
  reason?: string;
  /** `--net` as ink, never a fill (§18). Trash only — Restore undoes one. */
  destructive?: boolean;
}

/** An absent handler is NOT hidden: the target renders disabled, with a reason
 * the "cannot" arm cannot omit. */
export type SelectionHandler =
  | { run: () => void }
  | { unavailableReason: string };

export interface BuildSelectionActionsInput {
  count: number;
  shelf: SelectionShelfKind;
  copyLabel: string;
  /** Disables Favorite, Add to album and Trash/Restore only. */
  readOnlyReason: string | null;
  favorite: SelectionHandler;
  addToAlbum: SelectionHandler;
  share: SelectionHandler;
  download: SelectionHandler;
  trash: SelectionHandler;
}

function handlerOf(handler: SelectionHandler): {
  run: () => void;
  reason?: string;
  disabled: boolean;
} {
  return "run" in handler
    ? { run: handler.run, disabled: false }
    : { run: () => {}, reason: handler.unavailableReason, disabled: true };
}

/** THE INERT HANDLER IS THE POINT (§6): `disabled` stops a tap, the no-op stops
 * a direct `action.run()` reaching a refused vault write. */
export function buildSelectionActions({
  count,
  shelf,
  copyLabel,
  readOnlyReason,
  favorite,
  addToAlbum,
  share,
  download,
  trash,
}: BuildSelectionActionsInput): SelectionAction[] {
  const empty = count === 0;
  const isTrashShelf = shelf === "trash";
  const specs: SelectionAction[] = [
    {
      id: "favorite",
      label: "Favorite",
      icon: "heart",
      ...handlerOf(favorite),
    },
    {
      id: "add-to-album",
      label: "Add to album",
      icon: "album",
      ...handlerOf(addToAlbum),
    },
    {
      id: "share",
      label: copyLabel,
      icon: "share",
      ...handlerOf(share),
    },
    {
      id: "download",
      label: "Download",
      icon: "download",
      ...handlerOf(download),
    },
    {
      id: "trash",
      label: isTrashShelf ? "Restore" : "Trash",
      icon: isTrashShelf ? "restore" : "trash",
      destructive: !isTrashShelf,
      ...handlerOf(trash),
    },
  ];
  const netOff = readOnlyReason !== null;
  const writesHere = new Set<SelectionActionId>([
    "favorite",
    "add-to-album",
    "trash",
  ]);
  return specs.map((spec) => {
    const blockedByGrant = netOff && writesHere.has(spec.id);
    const disabled = spec.disabled || empty || blockedByGrant;
    const reason =
      spec.reason ??
      (blockedByGrant ? (readOnlyReason ?? undefined) : undefined);
    return {
      ...spec,
      disabled,
      ...(reason ? { reason } : {}),
      run: disabled ? () => {} : spec.run,
    };
  });
}

/** ONE line, not five: distinct reasons in bar order (§18). */
export function selectionBarReason(
  actions: readonly SelectionAction[]
): string | undefined {
  const seen: string[] = [];
  for (const action of actions) {
    if (action.reason && !seen.includes(action.reason))
      seen.push(action.reason);
  }
  return seen.length ? seen.join(" · ") : undefined;
}

export function toggleSelectionKey(
  selected: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function toggleSelectionRange(
  selected: ReadonlySet<string>,
  orderedKeys: readonly string[],
  anchor: string,
  target: string
): Set<string> {
  const from = orderedKeys.indexOf(anchor);
  const to = orderedKeys.indexOf(target);
  if (from < 0 || to < 0) return toggleSelectionKey(selected, target);
  const next = new Set(selected);
  const on = !next.has(target);
  for (
    let index = Math.min(from, to);
    index <= Math.max(from, to);
    index += 1
  ) {
    const key = orderedKeys[index]!;
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

export function toggleAllSelection(
  selected: ReadonlySet<string>,
  visibleKeys: readonly string[]
): Set<string> {
  return selected.size > 0 ? new Set() : new Set(visibleKeys);
}

export function pruneSelection(
  selected: ReadonlySet<string>,
  presentKeys: readonly string[]
): Set<string> {
  const present = new Set(presentKeys);
  return new Set([...selected].filter((key) => present.has(key)));
}

export type SelectionBatchResult<Target, Value> =
  | { target: Target; status: "fulfilled"; value: Value }
  | { target: Target; status: "rejected"; reason: unknown };

/** Serial order is the ledger's requirement; catching is the batch law's. */
export async function runSelectionBatch<Target, Value>(
  targets: readonly Target[],
  run: (target: Target, index: number) => Promise<Value>
): Promise<Array<SelectionBatchResult<Target, Value>>> {
  const results: Array<SelectionBatchResult<Target, Value>> = [];
  for (const [index, target] of targets.entries()) {
    try {
      results.push({
        target,
        status: "fulfilled",
        // oxlint-disable-next-line no-await-in-loop -- ledger order is the contract
        value: await run(target, index),
      });
    } catch (error) {
      results.push({ target, status: "rejected", reason: error });
    }
  }
  return results;
}
