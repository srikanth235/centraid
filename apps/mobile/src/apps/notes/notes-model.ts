import { decodeTextContent } from "@centraid/blueprints/apps/notes/format";
import type { ReplicaRow } from "@centraid/client/replica/native";

export interface NativeNote {
  id: string;
  rawId: string;
  title: string;
  body: string;
  format: string;
  pinned: boolean;
  trashed: boolean;
  updatedAt: string;
  createdAt: string;
  bodyContentId: string;
  purgeAt?: string;
  sourceVaultId?: string;
  canWrite: boolean;
  raw: ReplicaRow;
  references: NativeNoteReference[];
  backlinks: ReplicaRow[];
}

export interface NativeNoteReference {
  link: ReplicaRow;
  anchor?: ReplicaRow;
}

export function buildNotes(
  notes: ReplicaRow[],
  contents: ReplicaRow[],
  links: ReplicaRow[],
  anchors: ReplicaRow[] = []
): NativeNote[] {
  return notes
    .map((row): NativeNote => {
      const rawId = String(row.note_id);
      const scope =
        typeof row.__centraidScopeId === "string"
          ? row.__centraidScopeId
          : undefined;
      const content = contents.find(
        (candidate) =>
          candidate.content_id === row.body_content_id &&
          (!scope || candidate.__centraidScopeId === scope)
      );
      const within = (link: ReplicaRow): boolean =>
        !scope || link.__centraidScopeId === scope;
      return {
        id: scope ? `${scope}:${rawId}` : rawId,
        rawId,
        title: String(row.title ?? "Untitled"),
        body: decodeTextContent(content?.content_uri),
        format: String(row.format ?? "markdown"),
        pinned: Number(row.pinned) === 1,
        trashed: row.deleted_at != null,
        updatedAt: String(
          row.updated_at ?? row.created_at ?? new Date(0).toISOString()
        ),
        createdAt: String(row.created_at ?? ""),
        bodyContentId:
          typeof row.body_content_id === "string" ? row.body_content_id : "",
        ...(typeof row.purge_at === "string" ? { purgeAt: row.purge_at } : {}),
        ...(scope ? { sourceVaultId: scope } : {}),
        canWrite: row.__centraidCanWrite !== false,
        raw: row,
        references: links
          .filter(
            (link) =>
              within(link) &&
              link.from_type === "knowledge.note" &&
              link.from_id === rawId &&
              link.valid_to == null
          )
          .map((link) => ({
            link,
            anchor: anchors.find(
              (anchor) => within(anchor) && anchor.link_id === link.link_id
            ),
          })),
        backlinks: links.filter(
          (link) =>
            within(link) &&
            link.to_type === "knowledge.note" &&
            link.to_id === rawId &&
            link.valid_to == null
        ),
      };
    })
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        right.updatedAt.localeCompare(left.updatedAt)
    );
}
