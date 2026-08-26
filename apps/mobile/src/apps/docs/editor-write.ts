// The editor's write intent. Title and body are separate drafts; a missing
// body is not an empty one. `edit` requires body_text, so a title-only
// change (body absent or unchanged) uses `rename`.

export type EditorWriteIntent =
  | { kind: "nochange" }
  | {
      kind: "write";
      action: "rename";
      input: { document_id: string; title: string };
    }
  | {
      kind: "write";
      action: "edit";
      input: { document_id: string; body_text: string; title?: string };
    };

export function editorWrite(args: {
  documentId: string;
  baselineTitle: string;
  typedTitle: string | null;
  /** The document's own body on this device. `null` means it has not been had. */
  baselineBody: string | null;
  typedBody: string | null;
}): EditorWriteIntent {
  const draftTitle = (args.typedTitle ?? args.baselineTitle).trim();
  const titleChanged =
    draftTitle.length > 0 && draftTitle !== args.baselineTitle;
  if (args.baselineBody === null) {
    if (!titleChanged) return { kind: "nochange" };
    return {
      kind: "write",
      action: "rename",
      input: { document_id: args.documentId, title: draftTitle },
    };
  }
  const draftBody = args.typedBody ?? args.baselineBody;
  const bodyChanged = draftBody !== args.baselineBody;
  if (!bodyChanged && !titleChanged) return { kind: "nochange" };
  if (!bodyChanged) {
    return {
      kind: "write",
      action: "rename",
      input: { document_id: args.documentId, title: draftTitle },
    };
  }
  return {
    kind: "write",
    action: "edit",
    input: {
      document_id: args.documentId,
      body_text: draftBody,
      ...(titleChanged ? { title: draftTitle } : {}),
    },
  };
}
