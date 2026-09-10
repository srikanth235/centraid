// One table for "what is this Docs route called" (#1015, audit docs/findings#1).
//
// The pushed-shelf head names the place it returns TO. Before this table each
// of the thirteen call sites typed that name by hand, and all thirteen typed
// "All" — so the chevron went one way and its label and its VoiceOver string
// said another. A name a screen types about ANOTHER screen is a copy of a fact
// it does not own, and it drifted the moment it was written.
//
// So the name is derived, never passed: `DocsShelfHeader` titles itself from
// the route it is on and names its return target from the route beneath it on
// the stack. Params carry what only the pusher can know — a folder's name, a
// document's title — exactly as `DocsFolder.folderName` already does, so no
// header waits a replica round-trip to say where it is.

import { STAGE_PROPS } from "@centraid/blueprints/apps/docs/document-copy";
import { STARRED } from "@centraid/blueprints/apps/docs/shelves";
import { shelfCopy } from "@centraid/blueprints/apps/docs/view-copy";

import { SHARED_TITLE } from "./docs-copy";

/** The shape both `useRoute()` and a stack entry satisfy. Structural on
 *  purpose: the test names routes without building a navigator. */
export interface DocsRouteLike {
  name: string;
  params?: object | undefined;
}

/** The one document-shaped route param: a title rides along so a pushed head
 *  names the document before any read lands. */
const documentTitle = (params: object | undefined): string | undefined => {
  const title = (params as { title?: unknown } | undefined)?.title;
  return typeof title === "string" && title.trim() ? title : undefined;
};

const folderName = (params: object | undefined): string | undefined => {
  const name = (params as { folderName?: unknown } | undefined)?.folderName;
  return typeof name === "string" && name.trim() ? name : undefined;
};

const homeTitle = (params: object | undefined): string => {
  const destination = (params as { destination?: unknown } | undefined)
    ?.destination;
  switch (destination) {
    case "due":
      return "Coming due";
    case "shared":
      return SHARED_TITLE;
    case "search":
      return shelfCopy("built-in:search").title;
    case "starred":
      return shelfCopy(STARRED).title;
    default:
      // All and Folders both title "Docs" — the shared table's Title column.
      return shelfCopy(null).title;
  }
};

/** The app's own name, used when nothing is beneath this route on the stack
 *  (a deep link, or a cold start into a document). */
export const DOCS_ROOT_TITLE = "Docs";

/** What a Docs route calls itself. The head renders it, and the head one push
 *  deeper names its return target with it — one string, two readers. */
export function docsRouteTitle(route: DocsRouteLike | undefined): string {
  if (!route) return DOCS_ROOT_TITLE;
  switch (route.name) {
    case "DocsHome":
      return homeTitle(route.params);
    case "DocsFolder":
      return folderName(route.params) ?? "Folder";
    case "DocumentRead":
    case "DocumentViewer":
      return documentTitle(route.params) ?? "Document";
    case "DocumentEditor":
      return "Edit";
    case "DocumentVersions":
      return "Version history";
    case "DocumentProperties":
      return STAGE_PROPS.head;
    case "DocumentNames":
      return "Who this document names";
    case "DocsCapabilities":
      return "What Docs may read";
    case "DocsProposedFiling":
      return "Proposed filing";
    case "DocsAdd":
      return "Add to Docs";
    case "DocsUpload":
      return "Uploading";
    case "DocsScan":
      return "Scan a document";
    case "DocsRecent":
      return "Recently changed";
    case "DocsTrash":
      return "Trash";
    case "DocsStorage":
      return "Storage";
    default:
      return DOCS_ROOT_TITLE;
  }
}
