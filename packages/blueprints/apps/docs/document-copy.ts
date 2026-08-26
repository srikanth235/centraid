// What ONE DOCUMENT's screens say (§6.2, §7, §8). Nothing here knows what a
// shelf is, and no editor copy is owed: Docs edits no document.

export const VERSIONS_ACTIVITY_HEAD = "Activity";
export const VERSIONS_ACTIVITY_META = "folded in here, deliberately";
export const VERSIONS_CUT_NOTE =
  "The third column records whether a member, an app or a machine did it.";

export const RAIL_TABS = [
  { id: "props", label: "Properties" },
  { id: "facts", label: "Facts" },
  { id: "names", label: "Names" },
] as const;

export type RailTabId = (typeof RAIL_TABS)[number]["id"];

/** Each note is the spec's own sentence, never a paraphrase. */
export const RAIL_NOTES = {
  folder: "a label on the document, not a place it sits",
  owner: "this document is in your own space",
  namesOff: "Docs has not looked. One consent, running on this device",
  cannotRender:
    "nothing has been converted. Docs holds it, versions it and files it, and hands the file to an app that reads this kind",
  duplicateBytes:
    "One copy of the bytes, and every app that points at it points at the same copy.",
  footer: "Select another row and the rail follows it.",
} as const;

/** ABSENT, NEVER NEGATIVE (#821): "Not shared" would assert a fact where a
 *  wrong answer costs most. A folder share is not this document's share. */
export const SHARED_WITH_KEY = "Shared with";

export function sharedWithNote({
  viaFolder,
  pending,
}: {
  viaFolder?: string | null;
  pending?: number;
}): string | undefined {
  const parts: string[] = [];
  if (viaFolder) parts.push(`through ${viaFolder}`);
  if (pending && pending > 0) parts.push(`${pending} waiting to accept`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function cannotRenderFact(kindName: string): string {
  return `Docs cannot render ${kindName}`;
}

/** Named here, not inline, so the bar and the phone row cannot drift. */
export const STAGE_ACTIONS = {
  star: "Star",
  starred: "Starred",
  download: "Download",
  print: "Print",
  share: "Share",
  properties: "Properties",
  trash: "Trash",
  close: "Close",
} as const;

/** On the control, never a toast (§6). A PDF's viewer owns its printing. */
export const PRINT_REFUSALS = {
  embeddedViewer:
    "A PDF opens in its own viewer here, and that viewer owns its printing.",
  timeBased: "Sound and moving pictures do not print.",
  unrendered:
    "Docs cannot render this kind on this device, so it cannot lay it onto a sheet.",
} as const;

/** A note says what the value MEANS, or this is the facts list twice. Three
 *  handoff rows stay undrawn: their reads do not exist on this surface. */
export const STAGE_PROPS = {
  head: "Properties",
  title: "Title",
  titleHint: "rename this document",
  folder: "Folder",
  folderNote: "a label on this document · move it and nothing else changes",
  tags: "Tags",
  tagsEmpty: "none yet",
  device: "On this device",
  deviceNote: "where the bytes are, as the vault last swept them",
  deviceUnknown: "not swept yet",
  facts: "Facts",
  origin:
    "The document is identity; the bytes are content, deduplicated on the vault. Another document may hold these same bytes, so releasing this copy would not remove them.",
} as const;
