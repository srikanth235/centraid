// The kebab menu and the shared "Move to…" tree — plain DOM popovers built
// with kit's h()/popItem(), exactly as logic.ts always built them inline.
// Split out purely to keep logic.ts under the file-size cap (same factory
// pattern as versions.ts): closes over data.folders (read-only) plus the
// document-write functions logic.ts already owns, passed in rather than
// re-implemented here.
import { armConfirm, closePopover, h, openPopover, popItem } from './kit.ts';
import type { AppData, DriveDoc } from './types.ts';

interface PopoverDeps {
  data: AppData;
  openQuick: (id: string) => void;
  moveDocs: (ids: string[], folderId: string | null, name: string) => Promise<void>;
  startRenameDoc: (doc: DriveDoc) => Promise<void> | void;
  toggleStar: (doc: DriveDoc) => Promise<void> | void;
  trashDoc: (doc: DriveDoc) => Promise<void> | void;
}

export function createPopovers({
  data,
  openQuick,
  moveDocs,
  startRenameDoc,
  toggleStar,
  trashDoc,
}: PopoverDeps) {
  // One "Move to…" target row. `popItem` (kit.ts) builds the real button
  // node; these popovers stay plain DOM (built with `h()`/`popItem()`),
  // exactly as before — the target list mixes a fixed depth-0 root with
  // depth-1 folders, same as the vanilla builder always did.
  function moveTargetBtn(
    folderId: string | null,
    name: string,
    depth: number,
    ids: string[],
    single: DriveDoc | null,
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
        'p',
        { class: 'kit-popover-head' },
        single ? `Move “${single.title ?? 'document'}” to` : `Move ${docs.length} to`,
      );
      const scroll = h(
        'div',
        { class: 'kit-popover-scroll' },
        moveTargetBtn(null, 'Documents', 0, ids, single),
        ...data.folders.map((f) => moveTargetBtn(f.folder_id, f.name, 1, ids, single)),
      );
      box.append(head, scroll);
    });
  }

  function openDocMenu(anchor: HTMLElement, doc: DriveDoc) {
    closePopover();
    openPopover(anchor, (box) => {
      box.append(
        popItem('Open', () => {
          closePopover();
          openQuick(doc.document_id);
        }),
        h(
          'a',
          {
            class: 'kit-popover-item',
            role: 'menuitem',
            href: doc.content_uri,
            download: doc.title ?? 'file',
            onclick: closePopover,
          },
          'Download',
        ),
        popItem('Rename', () => {
          closePopover();
          startRenameDoc(doc);
        }),
        popItem(doc.starred ? 'Remove star' : 'Star', () => {
          closePopover();
          toggleStar(doc);
        }),
        popItem('Move to…', () => openMovePopover(anchor, [doc])),
        h('div', { class: 'kit-popover-sep' }),
        popItem(
          'Trash',
          async (e) => {
            const btn = e.currentTarget as HTMLElement;
            if (!armConfirm(btn, { armedLabel: 'Trash — sure?' })) return;
            closePopover();
            await trashDoc(doc);
          },
          { danger: true },
        ),
      );
    });
  }

  return { openMovePopover, openDocMenu };
}
