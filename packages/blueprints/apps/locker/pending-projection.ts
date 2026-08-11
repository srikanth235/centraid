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
    "trash-item": pendingItemAction,
    "restore-item": pendingItemAction,
    "purge-item": pendingItemAction,
    "star-item": pendingItemAction,
    "unstar-item": pendingItemAction,
  },
});

export default lockerPendingProjection;
