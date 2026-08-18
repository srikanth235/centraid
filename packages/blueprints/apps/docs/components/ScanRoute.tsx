// "Scan a document" — where documents are born on a phone (Docs spec §4.4).
//
// THE SHELF EXISTS BECAUSE THE MORE SHEET NAMES IT, and what it draws is the
// truth about this surface: there is no camera path here. A web seat cannot
// find page edges, straighten what it sees and lay three captures down as one
// PDF; what it can do is take the file the OS hands it, which is the share
// sheet, which is a different door and is named as such.
//
// The screen is NOT a dead end. Every row below goes somewhere or explains
// itself, because a member who taps "Scan a document" and meets a blank page
// has been told their phone cannot do something their phone can do.
import type { ReactNode } from "react";

import { Note, Panel, Rows, Screen, Section } from "./Blocks.tsx";
import type { Row } from "./Blocks.tsx";

export function ScanRoute({
  narrow,
  onUpload,
}: {
  /** The compact form factor. The capture path is a phone's, so the screen
   *  says something different at a desk. */
  narrow: boolean;
  onUpload: () => void;
}): ReactNode {
  const rows: Row[] = [
    {
      id: "sheet",
      label: "“Open in Docs” from Mail, Files or a message",
      sub: "it arrives with the name it had and lands unfiled. This is how most documents arrive on a phone",
      meta: "share sheet",
    },
    {
      id: "camera",
      label: "Your phone's own scanner",
      sub: "the Camera or Files app can already scan to a PDF; save it, then bring that PDF in here",
      action: { label: "Choose a file", onClick: onUpload },
    },
    {
      id: "photos",
      label: "From Photos",
      sub: "a photograph becomes a document over the same bytes — one copy of the content, seen from two apps",
      meta: "Photos",
    },
    {
      id: "contents",
      label: "What is not read",
      sub: "the words inside a scan. Turning a photographed page into text is a separate consent, and it is off",
      meta: "off",
      net: true,
    },
  ];

  return (
    <Screen label="Scan a document">
      <Panel
        net
        eyebrow="Not on this surface"
        title="Docs cannot drive the camera here"
        body={
          narrow
            ? "Finding the page edges, straightening what it sees and laying several captures down as one PDF is work this seat cannot do. Your phone can already do it, and Docs takes the result."
            : "Scanning is a phone's job — there is no camera to drive at a desk. The ways a scan reaches this drive are below."
        }
        facts={[
          { k: "what is missing", v: "a capture path in this seat", net: true },
          {
            k: "what still works",
            v: "anything your phone or scanner has already saved as a file",
          },
          {
            k: "what a scan lands as",
            v: "one document, unfiled, with the name it arrived with",
          },
        ]}
      />

      <Section
        label="How a scan reaches this drive"
        meta="three doors, all real"
      />
      <Rows ariaLabel="Ways a scan arrives" rows={rows} />

      <Note>
        A scanned page is a document: bytes, versions, a folder, a purge date.
        The words inside it are not read by anything until you say so — that is
        “Read the contents”, one of the four capabilities, and it is switched
        off.
      </Note>
    </Screen>
  );
}
