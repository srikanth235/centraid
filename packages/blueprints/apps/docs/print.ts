// PRINTING and its honest boundary (§7): the only document this app can hand
// the browser is one it laid out — a picture, or text it holds. PDFs keep the
// browser viewer's own print control; sound and video have no sheet. Both
// refuse ON THE CONTROL (§6) through `printRefusal`, never by firing first.
//
// Build the sheet with DOM calls into a same-origin `about:blank` frame, never
// an HTML string: nothing to escape, and it inherits the page's CSP.
//
// THE PICTURE IS PASSED IN, NOT RE-DERIVED — a `content_uri` is a
// credential-less vault path off the gateway origin, and the sheet sits
// outside the shell's `blob:` resolution.
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

export type PrintKind = "image" | "text";

export function printKind(doc: DriveDoc): PrintKind | null {
  if (isImage(doc)) return "image";
  // Judge THE KIND, not whether an inline data URI decodes: CAS-backed text is
  // one authorized read away, and `printDoc` does it.
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

/** Paper is white and ink black HERE and nowhere else: the theme does not own
 *  the sheet, and a dark page prints as a solid black rectangle. */
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

async function textOf(doc: DriveDoc): Promise<string> {
  const uri = doc.content_uri ?? "";
  if (uri.startsWith("data:")) return decodeDataUri(uri) ?? "";
  return loadBlobText(uri);
}

/** `imageSrc` is the src the stage already shows; ignored for text. The frame
 *  goes on `afterprint` AND on a timer — `afterprint` misfires on some engines
 *  and a left-behind frame holds the picture's bytes for the session. */
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

  // The page header and the print-to-PDF filename; never `about:blank`.
  sheet.title = doc.title || "Document";
  const style = sheet.createElement("style");
  style.textContent = SHEET_CSS;
  sheet.head.appendChild(style);

  const run = () => {
    view.focus();
    view.print();
    // Long enough for a modal dialog to snapshot the frame.
    window.setTimeout(clean, 1000);
  };
  view.addEventListener("afterprint", clean);

  if (kind === "image") {
    const img = sheet.createElement("img");
    img.alt = doc.title || "";
    // Print only once decoded: an `<img>` with no pixels prints an empty box.
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
    // A failed read prints nothing: a dialog would offer a blank page.
    .catch(clean);
}
