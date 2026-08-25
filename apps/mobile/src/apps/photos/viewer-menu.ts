// The viewer's `···` — the anchored menu behind the chip (#712).
//
// The `···` opens an ANCHORED POPOVER, never a bottom sheet: a bottom sheet
// answers a different question (see `kit/components/AnchoredMenu.tsx`'s own
// header for why). This module states which of iOS' rows this vault can
// honestly carry, as data —
// the same discipline `photos-library-menu.ts` uses for the Library header's
// menu, so the row set and its enabled/disabled logic can be asserted without
// a renderer.
//
// THE SET, ROW BY ROW — what is carried, what is not, and why:
//
//   Slideshow, Download, Send a copy — plain rows, no conditions.
//
//   Add to Album — a real write (`batchAddToAlbum`,
//   `photos-selection-writes.ts`), fired here for a selection of one. The
//   album CHOICE itself is an `Alert.alert` list, the same idiom
//   `PhotosHome.tsx`'s selection-bar "Add to album" already uses (read there
//   for the pattern; that file is owned by another pass right now, so this is
//   a parallel implementation of the same write and the same picker idiom,
//   not a shared component). It stays a plain `Alert`, not a nested
//   `AnchoredMenu` submenu, on purpose: `MenuSubmenuRow` (the kit component)
//   carries no `disabled` field, so a submenu row cannot honestly show "this
//   vault is read-only" the way an action row can — see below for how this
//   row spends the ONE text slot the kit component gives an action row to
//   carry that reason anyway.
//
//   Make key photo (#721) — the same `set-album-cover` write
//   `AlbumDetail.tsx`'s selection-bar "Make cover" fires, reached here without
//   leaving the viewer. It sits beside Add to Album because it is the same
//   kind of fact about the same relationship (which album, which cover) and
//   takes the same refusal ladder. It renders only when `albums` (this
//   photograph's OWN album memberships, resolved by the caller the same way
//   `PhotoLightbox.tsx` already resolves them for the info sheet's Albums
//   chips) is non-empty: a photograph in no album has nothing for the row to
//   set a cover ON, and that is a fact about the library, not a permission —
//   so the row is left out rather than shown permanently disabled, the same
//   omission rule `search-hits.ts` states for a group with nothing behind it.
//   Which album, when there is more than one, is the SAME picker idiom Add to
//   Album uses one row up — the consumer's `Alert.alert`, not a second
//   `AnchoredMenu` submenu for the reason already argued above.
//
//   Adjust Location — OPENS the info sheet rather than growing a second place
//   editor in the menu. `PhotoInfoSheet.tsx` already owns place (`placeName`,
//   `placeSetByYou`, `onRemovePlace`); a second editor for the one fact would
//   be the duplication this codebase forbids, not a convenience.
//
//   Hide / Unhide — the one row this pass had to wait on. `archived_at` sits
//   on `media_asset`, `timeline-engine.ts` already reads it into
//   `PhotoAsset.archived`, and `PhotosLibrary.tsx` already renders an "Open
//   archived photos" shelf with a live count — every door but the write
//   itself existed. The write itself was broken, not missing: the action
//   handler between the two typed layers
//   (`packages/blueprints/apps/photos/actions/update-asset.ts`) forwarded
//   `captured_at`, `title` and `favorite` to `media.update_asset` but
//   silently dropped `archived`, even though `app.json` declared it on the
//   action's input schema and the vault command genuinely applied it. A
//   member would have tapped Hide, seen nothing refuse them, and the
//   photograph would not have moved — a control that fails quietly is worse
//   than no control (§12 territory), so the row waited for that handler to
//   forward the field the way `favorite` already did. It now does, so the
//   row ships, keyed off `PhotoAsset.archived` exactly the way
//   `photos-library-menu.ts`'s Filter row keys off `favorite`.
//
// WHAT DID NOT SHIP, AND WHY — each of these was checked against the actual
// write surface before being left out, not assumed absent:
//
//   Adjust Date & Time. `PhotoInfoSheet.tsx`'s "Capture time" row is a
//   read-out (`<Text>{capture}</Text>`), not an input — there is no write to
//   send a menu row to. Inventing one here would be the second editor problem
//   again, this time for a fact that has no first editor yet.
//
//   Copy, Duplicate. No clipboard-image path and no duplicate-asset write
//   exist anywhere in this app; a row that opens onto nothing is not a
//   simplification, it is a promise the code cannot keep.
//
// Delete DID ship, on a second look. It was left out on the argument that the
// toolbar's Trash chip already carries the verb and that one destructive door
// per photograph beats two. iOS carries it in both places, and the parity is
// the point of this pass: a member with the menu already open should not have
// to dismiss it to reach a row the same menu has on their phone. The safety
// was never the row being hard to find — it is the confirm step behind it.

import type { MenuGroup } from "../../kit/components/AnchoredMenu";
import { READ_ONLY_VAULT_REASON } from "./viewer-model";

/** Why Add to Album cannot fire when the photograph has no vault row of its
 *  own yet — a device-only photograph nothing has backed up. The same fact
 *  `PhotoLightbox.tsx`'s `writeReason` states inline (`"This photograph is
 *  not in a vault yet."`) when a write is attempted directly; restated here
 *  as its own constant so the menu's copy cannot drift from a re-typed
 *  literal, the exact drift `READ_ONLY_VAULT_REASON`'s own header describes. */
export const NOT_IN_A_VAULT_YET_REASON =
  "This photograph is not in a vault yet.";

/**
 * The one refusal ladder every writing row in this menu climbs: read-only
 * beats no-vault-row, and either beats a plain grant. Add to Album and Hide
 * are the two writes here that can be refused, and they refuse for the same
 * two reasons — this is the one place that logic is spelled out, so it
 * cannot drift into two re-typed copies.
 */
function writeRefusalReason(input: {
  writable: boolean;
  hasVaultAsset: boolean;
}): string | undefined {
  if (!input.writable) return READ_ONLY_VAULT_REASON;
  if (!input.hasVaultAsset) return NOT_IN_A_VAULT_YET_REASON;
  return undefined;
}

export interface ViewerOverflowMenuInput {
  /** The vault grant on the current photograph — `PhotoAsset.canWrite`,
   *  the same flag the bottom toolbar reads. */
  writable: boolean;
  /** Whether the photograph has a vault row to write against at all. */
  hasVaultAsset: boolean;
  /** `PhotoAsset.archived` — which label the row shows, Hide or Unhide. */
  archived: boolean;
  /**
   * The albums THIS photograph already belongs to, resolved by the caller
   * from `core.collection_entry` — the same join `PhotoLightbox.tsx` already
   * walks for the info sheet's Albums chips (#721). Empty when the
   * photograph is in no album, in which case there is no album for "Make key
   * photo" to set a cover ON — the row is omitted entirely rather than shown
   * permanently disabled with a reason nobody asked for (`search-hits.ts`'s
   * own rule: a row with nothing behind it is left out, never faked).
   */
  albums: readonly { id: string; label: string }[];
  onSlideshow: () => void;
  onAddToAlbum: () => void;
  /**
   * "Make key photo" (#721): the same `set-album-cover` write
   * `AlbumDetail.tsx`'s "Make cover" control fires, aimed at whichever of
   * `albums` the member means. Takes no argument, the same shape
   * `onAddToAlbum` already has here — WHICH album is a picker concern the
   * consumer owns (an `Alert.alert` list when `albums.length > 1`, a direct
   * fire when there is exactly one), never this pure module's, exactly the
   * division `onAddToAlbum`'s own comment above argues for its own picker.
   */
  onMakeKeyPhoto: () => void;
  onAdjustLocation: () => void;
  onHide: () => void;
  onDownload: () => void;
  onSendCopy: () => void;
  /** The same trash the toolbar chip fires — see the Delete row's own comment
   *  for why the verb lives in two places, as it does on iOS. */
  onDelete: () => void;
}

/**
 * The `···` chip's whole menu, in iOS' OWN GROUP ORDER (re-checked against the
 * simulator, issue 712). iOS reads:
 *
 *   Copy · Duplicate · Hide · Slideshow
 *   Add to Album
 *   Adjust Date & Time · Adjust Location
 *   Delete
 *
 * This is that shape with the two rows the vault cannot honestly carry struck
 * out (Copy/Duplicate — no clipboard-image path and no duplicate write; Adjust
 * Date & Time — the capture time is a read-out, not an input; both argued at
 * length in the header above), plus one group iOS does not have. Hide moved
 * UP to sit beside Slideshow and Add to Album took a group of its own, because
 * the group boundaries are the menu's grammar: a member who knows where a row
 * lives in iOS should find it in the same band here, and the previous
 * arrangement put Hide two groups away from where it is on the phone in their
 * pocket.
 *
 * The extra group is Download · Send a copy. iOS has no equivalent — it puts
 * getting bytes out behind the toolbar's share chip — but this vault's bytes
 * can be on a gateway rather than on the device, so "fetch the original" is a
 * real, separate verb here that iOS never needed. It sits above Delete for
 * the same reason iOS keeps Delete last: the destructive row is the floor of
 * every menu, and nothing is placed under it.
 */
export function viewerOverflowMenuGroups(
  input: ViewerOverflowMenuInput
): MenuGroup[] {
  const addToAlbumReason = writeRefusalReason(input);
  const canAddToAlbum = addToAlbumReason === undefined;
  const hideReason = writeRefusalReason(input);
  const canHide = hideReason === undefined;
  const hideVerb = input.archived ? "Unhide" : "Hide";
  // Same refusal ladder as Add to Album — read-only beats no-vault-row, either
  // beats a plain grant — because setting a cover is the same kind of write
  // against the same photograph. Album MEMBERSHIP is a separate, third gate:
  // it is not a write refusal at all, so it is handled by simply not adding
  // the row (below) rather than folded into this reason string.
  const makeKeyPhotoReason = writeRefusalReason(input);
  const canMakeKeyPhoto = makeKeyPhotoReason === undefined;

  return [
    {
      key: "mode",
      rows: [
        {
          key: "hide",
          // One text slot, so the refusal rides after an em dash — see the
          // same carry on Add to Album below for why this is not a second,
          // shorter phrasing of the read-only truth.
          label: canHide ? hideVerb : `${hideVerb} — ${hideReason}`,
          icon: "Archive",
          disabled: !canHide,
          onSelect: input.onHide,
        },
        {
          key: "slideshow",
          label: "Slideshow",
          icon: "Play",
          onSelect: input.onSlideshow,
        },
      ],
    },
    {
      key: "album",
      rows: [
        {
          key: "add-to-album",
          // The kit's `MenuActionRow` has exactly one text slot — no second
          // line the toolbar's visible refusal sentence could sit on, and no
          // `reason` field the way `ViewerChromeTarget`'s `hint` prop offers.
          // Rather than inventing a second, shorter phrasing of the read-only
          // truth (the exact duplication `READ_ONLY_VAULT_REASON`'s header
          // forbids), the disabled label carries the real sentence after an
          // em dash: a screen reader gets the whole thing from
          // `accessibilityLabel` regardless of the one-line visual clip, and
          // the dimmed ink still tells a sighted member the row is refused.
          label: canAddToAlbum
            ? "Add to Album"
            : `Add to Album — ${addToAlbumReason}`,
          icon: "FolderPlus",
          disabled: !canAddToAlbum,
          onSelect: input.onAddToAlbum,
        },
        // "Make key photo" only when the photograph is IN an album already —
        // see `ViewerOverflowMenuInput.albums`'s own comment for why an empty
        // set omits the row instead of showing it disabled with a reason.
        ...(input.albums.length
          ? [
              {
                key: "make-key-photo",
                label: canMakeKeyPhoto
                  ? "Make key photo"
                  : `Make key photo — ${makeKeyPhotoReason}`,
                icon: "Star",
                disabled: !canMakeKeyPhoto,
                onSelect: input.onMakeKeyPhoto,
              },
            ]
          : []),
      ],
    },
    {
      key: "adjust",
      rows: [
        {
          key: "adjust-location",
          label: "Adjust Location",
          icon: "Pin",
          onSelect: input.onAdjustLocation,
        },
      ],
    },
    {
      key: "export",
      rows: [
        {
          key: "download",
          label: "Download",
          icon: "Download",
          onSelect: input.onDownload,
        },
        {
          key: "send-copy",
          label: "Send a copy",
          icon: "Send",
          onSelect: input.onSendCopy,
        },
      ],
    },
    {
      key: "destructive",
      rows: [
        {
          key: "delete",
          // Delete is in BOTH places on iOS — the toolbar's trash chip and the
          // bottom of this menu — and that parity outranks the tidier argument
          // for one door. A member who
          // has the menu open should not have to close it to reach the verb
          // the same menu carries on the phone they came from. The confirm
          // step is where the safety lives (`PhotoLightbox.tsx`), not in the
          // row being hard to find.
          label: "Delete",
          icon: "trash-2",
          destructive: true,
          disabled: !canHide,
          onSelect: input.onDelete,
        },
      ],
    },
  ];
}
