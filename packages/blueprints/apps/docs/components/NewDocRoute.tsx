// "Add to Docs" — the ways in (Docs spec §4.4).
//
// A ROUTE, NOT A MENU, so that it can be described. A dropdown can offer
// "Upload files" and "New folder"; it cannot tell a member that dragging onto
// the window works anywhere in the drive, that a file on the clipboard becomes
// a document under the same policy as an upload, or that dragging a document
// OUT fetches its bytes if they are not on this device. Those are the three
// doors nobody discovers, and a menu is the one place they cannot be written
// down.
//
// Each row is honest about which surfaces it exists on: the pointer-only ways
// in say so in their reading rather than being hidden on a phone, because "this
// works at your desk" is a useful thing to know from a phone.
import type { ReactNode } from "react";

import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

export function NewDocRoute({
  narrow,
  onUpload,
  onNewFolder,
}: {
  /** The compact form factor — no file space beside the window, so drag and
   *  paste are described rather than offered. */
  narrow: boolean;
  onUpload: () => void;
  onNewFolder: () => void;
}): ReactNode {
  const pointerOnly = narrow
    ? "not on a phone — there is no file space beside the window"
    : "desktop and web";

  const rows: Row[] = [
    {
      id: "upload",
      label: "Upload files",
      sub: "from this device. They land unfiled unless you are inside a folder",
      action: { label: "Choose…", filled: true, onClick: onUpload },
    },
    {
      id: "folder",
      label: "A folder",
      sub: "a label, created empty. Nothing is moved into it",
      action: { label: "New folder", onClick: onNewFolder },
    },
    {
      id: "drag",
      label: "Drag onto the window",
      sub: "anywhere in the drive; the drop target is the whole surface",
      meta: pointerOnly,
      net: narrow,
    },
    {
      id: "paste",
      label: "Paste",
      sub: "a file on the clipboard becomes a document. Same queue, same policy",
      meta: pointerOnly,
      net: narrow,
    },
    {
      id: "dragout",
      label: "Drag a document out",
      sub: "onto the desktop or into another app. The bytes are fetched if they are not here",
      meta: pointerOnly,
      net: narrow,
    },
    {
      id: "share",
      label: "“Open in Docs” from another app",
      sub: "it arrives with the name it had and lands unfiled. This is how most documents arrive on a phone",
      meta: "share sheet",
    },
  ];

  return (
    <Screen label="Add to Docs">
      <Rows ariaLabel="Ways in" rows={rows} />

      {/* NO DUPLICATES SHELF, and the judgement behind that belongs here —
          this is the screen about bringing things in, so it is where the
          product's position on bringing the same thing in twice is stated. */}
      <Section
        label="Two documents over the same bytes"
        meta="a judgement, stated"
      />
      <Panel
        eyebrow="Byte-identical"
        title="Keeping both is free, and never blocked"
        body="When the bytes you bring in are already in the vault under another name, Docs says so at the moment you add it — and then keeps both if you want both."
        facts={[
          { k: "what matched", v: "the bytes, exactly" },
          {
            k: "cost of keeping both",
            v: "nothing. One copy of the bytes, two documents",
          },
          { k: "what is never done", v: "refusing the second one" },
        ]}
      />
      <Note>
        In Photos a duplicate is an accident worth reviewing in bulk. In Docs a
        second document over the same bytes is usually deliberate — a signed
        copy, a version somebody sent back — so there is no duplicates shelf.
        The notice at upload is where the decision is.
      </Note>
    </Screen>
  );
}
