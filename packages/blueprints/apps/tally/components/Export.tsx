// EXPORT — the custodian's surface (GAPS.md Tally §8).
//
// LOCAL-FIRST MAKES LEAVING POSSIBLE, and that is the point of it: a sovereign
// vault must not be a roach motel. The `export` query answers with one group's
// rows; the FILE is assembled here and saved from here, which is why the foot
// reads in `--net` — the bytes leave the vault the moment the member saves it,
// and nothing before that moment has left anything.
//
// SPLITS AND REVISIONS TRAVEL; BALANCES DO NOT. A balance is arithmetic over
// the rows, and the rows are what the file holds — so the export cannot ship a
// figure this app refuses to store. The payload says `balances_excluded` out
// loud rather than leaving a reader to notice the absence.
//
// THE WINDOW IS STATED. `truncated` and `window` come back with the rows, so a
// partial export is never mistaken for a whole one: the foot names the counts
// before the press, and a file that carries the window says so.
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
  /** The rows the chosen group's `export` query answered with, or `null` while
   *  that read is in flight — and then the counts are absent rather than zero,
   *  because "nothing to export" is a claim nobody has checked. */
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
