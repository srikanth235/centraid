import type { ReactNode } from "react";

import {
  CANCEL,
  EXPORT_COMMIT,
  EXPORT_FOOT,
  EXPORT_FORMATS,
  EXPORT_HEAD,
  EXPORT_LEDE,
  EXPORT_NO_GROUP,
  EXPORT_NOTE,
  EXPORT_RANGES,
  FIELD_KEYS,
  exportWindow,
} from "../compose-copy.ts";
import { metaSentence } from "../format.ts";
import type { ExportData, GroupSummary } from "../types.ts";
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
  data: ExportData | null;
  onPatch: (patch: Partial<ExportDraft>) => void;
  onCancel: () => void;
  onCommit: () => void;
}

export function ExportScreen(props: ExportScreenProps): ReactNode {
  const ready = props.draft.groupId !== null && props.data !== null;
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
        copy={metaSentence([
          EXPORT_FOOT,
          props.data
            ? exportWindow(
                props.data.window.expenses,
                props.data.window.settlements,
                props.data.truncated
              )
            : "",
        ])}
        net
        cancelLabel={CANCEL}
        onCancel={props.onCancel}
        commit={{
          label: EXPORT_COMMIT,
          ...(ready ? {} : { refusal: EXPORT_NO_GROUP }),
          run: props.onCommit,
        }}
      />
    </Editor>
  );
}
