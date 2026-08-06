// The selection bottom bar, as a model (Photos v4 handoff §6, proto:4946).
//
// While a selection is live the band is REPLACED by this bar — proto:4953's
// `appBandOn: …&&!sel` is exactly that rule — and the bar carries five 56px
// targets in one fixed order. The order and the two shelf swaps (Trash →
// Restore, Sharing → Remove from Sharing) live here, in a module free of
// `react-native`, for the same reason `photos-band.ts` does: they are rules,
// they must be assertable without a renderer, and the web's own selection bar
// (`packages/blueprints/apps/photos/components/SelectionBar.tsx`,
// `buildSelectionActions`) states them in one place too. Two surfaces, one
// table, so the fifth target cannot mean `Trash` on the phone and `Download`
// on the desktop.
//
// SHARING ON THE PHONE. The third target's shelf swap is modelled here even
// though no Sharing shelf exists on the phone yet (see `photos-band.ts` for
// why the More sheet carries no Sharing row): the swap is the rule, and a
// rule that is only written down once the surface ships is a rule that ships
// wrong. `shelf: "sharing"` is unreachable from a mobile screen today and
// every mobile caller passes "normal" or "trash".

/** The five, by id, in the handoff's fixed order. */
export type SelectionActionId =
  | "favorite"
  | "add-to-album"
  | "share"
  | "download"
  | "trash";

/** Which swap applies to the fixed five (§6). */
export type SelectionShelfKind = "trash" | "sharing" | "normal";

/** The phone's selection targets. Above the 44 floor: this is the primary bar
 *  while a selection is live, exactly as the viewer's bar is (§7.1, §6). */
export const SELECTION_ACTION_TARGET = 56;

export interface SelectionAction {
  id: SelectionActionId;
  /** Copy is final (§6) — icon-only would be an unnamed control (§18), so the
   *  caption under the mark is this same string. */
  label: string;
  /** Semantic icon key, resolved by `kit/components/icon-resolver`. */
  icon: string;
  /** Fires the write. INERT when `disabled` — see `buildSelectionActions`. */
  run: () => void;
  disabled: boolean;
  /** Why it cannot fire, as one sentence. Stated inline under the bar in
   *  `--net` mono by the renderer — never only in an accessibility hint,
   *  which is the touch surface's tooltip (§6, §18). */
  reason?: string;
  /** Takes `--net` as ink, never as a fill (§18). Trash only; Restore undoes
   *  a destructive action rather than being one. */
  destructive?: boolean;
}

/**
 * What one screen can actually do with a selection. A handler that is absent
 * is NOT hidden: the target still renders, disabled, with the caller's own
 * sentence saying why — which is why the "cannot" arm carries a reason and
 * cannot be constructed without one.
 */
export type SelectionHandler =
  | { run: () => void }
  | { unavailableReason: string };

export interface BuildSelectionActionsInput {
  count: number;
  shelf: SelectionShelfKind;
  /** Non-null when the scope the selection sits in refuses writes (§6):
   *  Favorite, Add to album and Trash/Restore disable with this sentence.
   *  Copy to Sharing and Download do not — copying into the member's OWN
   *  vault, and downloading, are never writes on someone else's library. */
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

/**
 * The five, in the fixed order, with the shelf swaps applied and every
 * disabled target's handler replaced by a no-op.
 *
 * THE INERT HANDLER IS THE POINT (§6, proto `act:off?()=>{}:…`). A `disabled`
 * prop is what stops a tap or an assistive-tech activation; the no-op is what
 * stops anything calling `action.run()` directly — a test, a future caller, a
 * synthetic activation — from reaching a vault write the member's grant, or
 * the phone's missing surface, refuses.
 */
export function buildSelectionActions({
  count,
  shelf,
  readOnlyReason,
  favorite,
  addToAlbum,
  share,
  download,
  trash,
}: BuildSelectionActionsInput): SelectionAction[] {
  const empty = count === 0;
  const isTrashShelf = shelf === "trash";
  const isSharingShelf = shelf === "sharing";
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
      label: isSharingShelf ? "Remove from Sharing" : "Copy to Sharing",
      icon: isSharingShelf ? "removeFrom" : "share",
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
  // The read-only sentence applies to the three targets that WRITE into the
  // scope being read. Download and Copy to Sharing are deliberately exempt.
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

/**
 * The one sentence under the bar. A member reads ONE line, not five: the
 * distinct reasons, in the bar's own order, joined by the system's `·`
 * separator (§18 — never an unspaced em dash).
 */
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
