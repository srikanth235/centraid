import {
  definePendingProjection,
  pendingPatch,
} from "../_shared/pending-overlay.js";

const ONLINE_ONLY_SECRET = {
  excluded: true,
  reason:
    "Locker reveal and secret mutation are deliberately online-only; no secret value enters a replica overlay.",
} as const;

const pendingItemAction = ({
  input,
}: {
  input: Readonly<Record<string, unknown>>;
}) => pendingPatch("locker.item", input.item_id, input);

export const lockerPendingProjection = definePendingProjection({
  appId: "locker",
  actions: {
    "add-item": ONLINE_ONLY_SECRET,
    "edit-item": ONLINE_ONLY_SECRET,
    // #872: a custom field and a passkey slot both carry sealed material, and
    // an export's RESULT is every secret in the locker. Same partition, same
    // reason — `writes.ts`'s ONLINE_ONLY_ACTIONS and this map are the whole
    // of it, and `writes.test.ts` holds them to each other.
    "set-field": ONLINE_ONLY_SECRET,
    "set-passkey": ONLINE_ONLY_SECRET,
    export: ONLINE_ONLY_SECRET,
    "trash-item": pendingItemAction,
    "restore-item": pendingItemAction,
    "purge-item": pendingItemAction,
    "star-item": pendingItemAction,
    "unstar-item": pendingItemAction,
    "archive-item": pendingItemAction,
    "unarchive-item": pendingItemAction,
    // A duplicate mints a NEW id the vault chooses, so there is no row to
    // patch optimistically — it queues without an overlay.
    "duplicate-item": pendingItemAction,
    "remove-field": pendingItemAction,
    "set-addresses": pendingItemAction,
    "clear-passkey": pendingItemAction,
  },
});
