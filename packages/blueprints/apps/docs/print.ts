// PRINTING, and the honest boundary of it (§7's `Print` on the stage).
//
// The browser prints A DOCUMENT, and the only document this app can hand it is
// one this app laid out itself. That is the whole rule, and it is why `Print`
// is live for exactly two kinds:
//
//   * A PICTURE — one `<img>` on a sheet, which is a layout.
//   * TEXT THIS APP HOLDS — the same characters the reading view sets, in the
//     same reading register, which is also a layout.
//
// A PDF is laid out by the BROWSER'S OWN VIEWER inside the stage's frame, and
// that viewer carries its own print control — a second one out here would be
// two controls for one job, and the outer one could not drive the inner
// document anyway. Sound and moving pictures have no sheet at all. Both say so
// ON THE CONTROL (§6) rather than firing and apologising, which is what
// `printRefusal` is for.
//
// The sheet is built with DOM calls into a same-origin `about:blank` frame,
// never an HTML string: no escaping to get wrong, and the frame inherits the
// page's own CSP.
//
// THE PICTURE IS PASSED IN, NOT RE-DERIVED. Off the gateway origin a document's
// `content_uri` is a relative vault path that carries no credential — the shell
// authorizes it in the app's own tree and hands the element a `blob:` URL. The
// print sheet is a DIFFERENT document, outside that watch, so re-using the raw
// path there would print a broken image. The caller passes the src the stage is
// ALREADY showing, which is same-origin and loads in the sheet unchanged.
import { loadBlobText } from "./blob-text.ts";
import { PRINT_REFUSALS } from "./document-copy.ts";
import {
  decodeDataUri,
  isAudio,
  isImage,
  isTextKind,
  isVideo,
  loadable,
} from "./format.ts";
import type { DriveDoc } from "./types.ts";

/** What this app can lay onto a sheet, or `null` if it cannot. */
export type PrintKind = "image" | "text";

export function printKind(doc: DriveDoc): PrintKind | null {
  if (isImage(doc)) return "image";
  // THE KIND, not "did an inline data URI happen to decode". A text document
  // whose bytes live in the vault's CAS prints exactly as well as one carried
  // inline — it is one authorized read away, and `printDoc` does that read.
  if (isTextKind(doc)) return "text";
  return null;
}

/** Why Print cannot fire — the sentence the disabled control carries. */
export function printRefusal(doc: DriveDoc): string {
  if (isAudio(doc) || isVideo(doc)) return PRINT_REFUSALS.timeBased;
  if (
    String(doc.media_type ?? "") === "application/pdf" &&
    loadable(doc.content_uri)
  )
    return PRINT_REFUSALS.embeddedViewer;
  return PRINT_REFUSALS.unrendered;
}

/** The print sheet's own stylesheet. Paper is white and ink is black HERE and
 *  nowhere else in the product: the sheet is not a surface the theme owns, and
 *  a stage-dark page would come out of a printer as a solid black rectangle. */
const SHEET_CSS = `
  @page { margin: 18mm; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  img { display: block; max-width: 100%; }
  pre {
    margin: 0;
    font: 12pt/1.6 Georgia, "Times New Roman", serif;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
`;

/** The document's own characters, from wherever this seat can reach them. */
async function textOf(doc: DriveDoc): Promise<string> {
  const uri = doc.content_uri ?? "";
  if (uri.startsWith("data:")) return decodeDataUri(uri) ?? "";
  return loadBlobText(uri);
}

/**
 * Lay the document onto a sheet and open the browser's print dialog.
 *
 * `imageSrc` is the src the stage is currently showing for a picture — see the
 * note at the top of this file. It is ignored for text.
 *
 * The frame is removed on `afterprint` AND on a timer, because `afterprint`
 * does not fire on every engine when the dialog is dismissed — a hidden frame
 * left in the tree would hold the picture's bytes alive for the rest of the
 * session.
 */
export function printDoc(doc: DriveDoc, imageSrc?: string | null): void {
  const kind = printKind(doc);
  if (!kind) return;

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.style.cssText =
    "position:fixed;inset-block-start:-10000px;inline-size:1px;block-size:1px;border:0;opacity:0";
  document.body.appendChild(frame);

  const sheet = frame.contentDocument;
  const view = frame.contentWindow;
  if (!sheet || !view) {
    frame.remove();
    return;
  }

  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    frame.remove();
  };

  // The printed page's own title is what most engines put in the header and
  // offer as the filename of a print-to-PDF, so it is the document's title
  // and not `about:blank`.
  sheet.title = doc.title || "Document";
  const style = sheet.createElement("style");
  style.textContent = SHEET_CSS;
  sheet.head.appendChild(style);

  const run = () => {
    view.focus();
    view.print();
    // Long enough for a modal print dialog to have taken its snapshot of the
    // frame; the `afterprint` listener below usually gets there first.
    window.setTimeout(clean, 1000);
  };
  view.addEventListener("afterprint", clean);

  if (kind === "image") {
    const img = sheet.createElement("img");
    img.alt = doc.title || "";
    // Decoded before the dialog opens: printing an `<img>` that has no pixels
    // yet prints an empty box.
    img.addEventListener("load", run);
    img.addEventListener("error", clean);
    img.src = imageSrc || doc.content_uri || "";
    sheet.body.appendChild(img);
    return;
  }

  const pre = sheet.createElement("pre");
  sheet.body.appendChild(pre);
  void textOf(doc)
    .then((text) => {
      pre.textContent = text;
      run();
    })
    // A read that did not land prints nothing rather than an empty sheet: the
    // dialog would offer to commit a blank page to paper.
    .catch(clean);
}
