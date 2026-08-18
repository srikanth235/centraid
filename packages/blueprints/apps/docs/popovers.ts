// The kebab menu and the shared "Move to…" tree — plain DOM popovers built
// with kit's h()/popItem(), exactly as logic.ts always built them inline.
// Split out purely to keep logic.ts under the file-size cap (same factory
// pattern as versions.ts): closes over data.folders (read-only) plus the
// document-write functions logic.ts already owns, passed in rather than
// re-implemented here.
import {
  armConfirm,
  closePopover,
  h,
  openPopover,
  popItem,
} from "@centraid/design/elements";

import { MENU_ICONS } from "./icons.ts";
import type { AppData, DriveDoc } from "./types.ts";

interface PopoverDeps {
  data: AppData;
  openQuick: (id: string) => void;
  openDetails: (id: string) => void;
  openVersions: (id: string) => void;
  moveDocs: (
    ids: string[],
    folderId: string | null,
    name: string
  ) => Promise<void>;
  startRenameDoc: (doc: DriveDoc) => Promise<void> | void;
  toggleStar: (doc: DriveDoc) => Promise<void> | void;
  trashDoc: (doc: DriveDoc) => Promise<void> | void;
  restoreDoc: (doc: DriveDoc) => Promise<void> | void;
}

export function createPopovers({
  data,
  openQuick,
  openDetails,
  openVersions,
  moveDocs,
  startRenameDoc,
  toggleStar,
  trashDoc,
  restoreDoc,
}: PopoverDeps) {
  // One "Move to…" target row. `popItem` (the element layer) builds the real button
  // node; these popovers stay plain DOM (built with `h()`/`popItem()`),
  // exactly as before — the target list mixes a fixed depth-0 root with
  // depth-1 folders, same as the vanilla builder always did.
  function moveTargetBtn(
    folderId: string | null,
    name: string,
    depth: number,
    ids: string[],
    single: DriveDoc | null
  ): HTMLButtonElement {
    const btn = popItem(name, async () => {
      closePopover();
      await moveDocs(ids, folderId, name);
    });
    btn.style.paddingLeft = `${0.7 + depth * 0.85}rem`;
    if (single && (single.folder_id ?? null) === folderId) btn.disabled = true;
    return btn;
  }

  // One shared "Move to…" tree for the kebab and the bulk toolbar.
  function openMovePopover(anchor: HTMLElement, docs: DriveDoc[]) {
    const ids = docs.map((d) => d.document_id);
    const single = docs.length === 1 ? docs[0]! : null;
    openPopover(anchor, (box) => {
      const head = h(
        "p",
        { class: "kit-popover-head" },
        single
          ? `Move “${single.title ?? "document"}” to`
          : `Move ${docs.length} to`
      );
      const scroll = h(
        "div",
        { class: "kit-popover-scroll" },
        moveTargetBtn(null, "Documents", 0, ids, single),
        ...data.folders.map((f) =>
          moveTargetBtn(f.folder_id, f.name, 1, ids, single)
        )
      );
      box.append(head, scroll);
    });
  }

  /**
   * The row menu (the handoff's `menu:[...]` on `docRowsBlock`). Drive's ⋮ is
   * where rename, move, star, history and trash actually live; without it
   * every one of those verbs is homeless on a row.
   *
   * EVERY ITEM WEARS ITS GLYPH (`icons.ts` `MENU_ICONS`). The handoff gives
   * each entry an `icon` alongside its `label`, and a menu where some items
   * carry one and others carry a gap reads as a menu with something missing.
   *
   * TWO OF THE HANDOFF'S ENTRIES ARE NOT DRAWN, both because they would be
   * dead:
   *   * `Place in a space` — Docs shares FOLDERS (`ShareSheet`), and a
   *     per-document placement has no flow behind it yet.
   *   * `Delete forever` — THE PLATFORM HAS NO DESTROY VERB (frame.tsx's
   *     `NO_PRIMARY`): destruction happens only on the schedule a purge date
   *     announces, so the trashed row offers Restore and says nothing it
   *     cannot do.
   * A menu that is half dead ends is worse than a shorter menu.
   */
  function openDocMenu(anchor: HTMLElement, doc: DriveDoc) {
    closePopover();
    openPopover(anchor, (box) => {
      if (doc.trashed) {
        box.append(
          popItem(
            "Restore",
            () => {
              closePopover();
              void restoreDoc(doc);
            },
            { iconHtml: MENU_ICONS.history }
          ),
          popItem(
            "Details",
            () => {
              closePopover();
              openDetails(doc.document_id);
            },
            { iconHtml: MENU_ICONS.details }
          )
        );
        return;
      }
      box.append(
        popItem(
          "Open",
          () => {
            closePopover();
            openQuick(doc.document_id);
          },
          { iconHtml: MENU_ICONS.open }
        ),
        h(
          "a",
          {
            class: "kit-popover-item",
            role: "menuitem",
            href: doc.content_uri,
            download: doc.title ?? "file",
            onclick: closePopover,
          },
          // The download entry is a real `<a download>`, not a button, so the
          // glyph is appended here rather than passed to `popItem`. `flex:
          // none` because `.kit-popover-item` is a flex row and an SVG that
          // may shrink is an SVG that will.
          h("i", {
            style: "display:flex;flex:none",
            html: MENU_ICONS.download,
          }),
          "Download"
        ),
        popItem(
          "Rename",
          () => {
            closePopover();
            void startRenameDoc(doc);
          },
          { iconHtml: MENU_ICONS.rename }
        ),
        popItem("Move to…", () => openMovePopover(anchor, [doc]), {
          iconHtml: MENU_ICONS.move,
        }),
        popItem(
          doc.starred ? "Remove star" : "Star",
          () => {
            closePopover();
            void toggleStar(doc);
          },
          { iconHtml: MENU_ICONS.star }
        ),
        popItem(
          "Version history",
          () => {
            closePopover();
            openVersions(doc.document_id);
          },
          { iconHtml: MENU_ICONS.history }
        ),
        popItem(
          "Details",
          () => {
            closePopover();
            openDetails(doc.document_id);
          },
          { iconHtml: MENU_ICONS.details }
        ),
        h("div", { class: "kit-popover-sep" }),
        popItem(
          "Move to trash",
          async (e) => {
            const btn = e.currentTarget as HTMLElement;
            if (!armConfirm(btn, { armedLabel: "Trash — sure?" })) return;
            closePopover();
            await trashDoc(doc);
          },
          { danger: true, iconHtml: MENU_ICONS.trash }
        )
      );
    });
  }

  return { openMovePopover, openDocMenu };
}
