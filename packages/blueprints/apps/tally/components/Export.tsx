// EXPORT — the custodian's surface, drawn against the ask (GAPS.md Tally §8).
//
// LOCAL-FIRST MAKES LEAVING POSSIBLE, and that is the point of it: a sovereign
// vault must not be a roach motel. So the surface exists, states exactly what
// a file would carry, and refuses at the commit with the gap named — rather
// than being absent, which would teach a member that leaving is not on offer.
//
// SPLITS AND REVISIONS TRAVEL; BALANCES DO NOT. A balance is arithmetic over
// the rows, and the rows are what the file holds — so the export cannot ship a
// figure this app refuses to store.
//
// THE FOOT READS IN `--net`. It is the one sentence in Tally that is not about
// owing: bytes leave the device the moment the file is saved, and `--net` is
// the product's register for exactly that.
import type { ReactNode } from "react";

import {
  CANCEL,
  EXPORT_COMMIT,
  EXPORT_FOOT,
  EXPORT_FORMATS,
  EXPORT_HEAD,
  EXPORT_LEDE,
  EXPORT_NOTE,
  EXPORT_RANGES,
  EXPORT_UNBUILT,
  FIELD_KEYS,
} from "../compose-copy.ts";
import type { GroupSummary } from "../types.ts";
import {
  ChipSet,
  Editor,
  EditorFoot,
  EditorHead,
  FieldRow,
} from "./Fields.tsx";

export interface ExportDraft {
  groupId: string | null;
  range: string;
  format: string;
}

export interface ExportScreenProps {
  draft: ExportDraft;
  groups: readonly GroupSummary[];
  onPatch: (patch: Partial<ExportDraft>) => void;
  onCancel: () => void;
}

export function ExportScreen(props: ExportScreenProps): ReactNode {
  return (
    <Editor>
      <EditorHead head={EXPORT_HEAD} lede={EXPORT_LEDE} />

      <FieldRow label={FIELD_KEYS.group}>
        <ChipSet
          options={props.groups.map((group) => ({
            id: group.group_id,
            label: group.name,
          }))}
          value={props.draft.groupId}
          label={FIELD_KEYS.group}
          onPick={(groupId) => props.onPatch({ groupId })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.range}>
        <ChipSet
          options={EXPORT_RANGES.map(([id, label]) => ({ id, label }))}
          value={props.draft.range}
          label={FIELD_KEYS.range}
          onPick={(range) => props.onPatch({ range })}
        />
      </FieldRow>

      <FieldRow label={FIELD_KEYS.format} note={EXPORT_NOTE}>
        <ChipSet
          options={EXPORT_FORMATS.map(([id, label]) => ({ id, label }))}
          value={props.draft.format}
          label={FIELD_KEYS.format}
          onPick={(format) => props.onPatch({ format })}
        />
      </FieldRow>

      <EditorFoot
        copy={EXPORT_FOOT}
        net
        cancelLabel={CANCEL}
        onCancel={props.onCancel}
        commit={{
          label: EXPORT_COMMIT,
          refusal: EXPORT_UNBUILT,
          run: props.onCancel,
        }}
      />
    </Editor>
  );
}
