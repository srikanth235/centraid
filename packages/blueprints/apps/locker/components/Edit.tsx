import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  SEALED,
  carriesMatchPolicy,
  fieldsFor,
  isSealedField,
} from "../draft.ts";
import type { DraftField } from "../draft.ts";
import { typeLabel } from "../format.ts";
import { SEALED_RUN } from "../item-fields.ts";
import {
  ALIAS_NOTE,
  ALIAS_PLACEHOLDER,
  ALIAS_ROW,
  EDIT_CANCEL,
  EDIT_FOOT,
  EDIT_FOOT_OFFLINE,
  EDIT_HEAD_EDIT,
  EDIT_HEAD_NEW,
  EDIT_LEDE_TAIL,
  EDIT_SAVE,
  FIELD_NOTE,
  MATCH_DOMAIN,
  MATCH_HOST,
  MATCH_NOTE_DOMAIN,
  MATCH_NOTE_HOST,
  MATCH_POLICY_ROW,
  SEALED_UNCHANGED,
  TAGS_NOTE,
  TAGS_PLACEHOLDER,
  TAGS_ROW,
  TITLE_NOTE,
  TITLE_PLACEHOLDER,
  TITLE_ROW,
  TYPE_NOTE,
  TYPE_ROW,
} from "../route-copy.ts";
import type { SidecarDraft } from "../session.ts";
import type {
  ItemDraftSeed,
  LockerDetail,
  LockerItemType,
  UrlMatchPolicy,
} from "../types.ts";
import { ALL_TYPES, EDIT_LEDE, GENERATE, TYPE_LABEL } from "../view-copy.ts";
import { EditSidecars } from "./EditSidecars.tsx";
import type { SidecarActs } from "./EditSidecars.tsx";
import { FieldRow } from "./Fields.tsx";

import styles from "./Rows.module.css";

export interface EditScreenProps extends SidecarActs {
  seed: ItemDraftSeed;
  detail: LockerDetail | null;
  sidecarDraft: SidecarDraft;
  offline: boolean;
  busy: boolean;
  error: string;
  onChange: (seed: ItemDraftSeed) => void;
  onRetype: (type: LockerItemType) => void;
  onGenerate: () => void;
  onSave: () => void;
  onCancel: () => void;
}

function fieldNote(field: DraftField): string | undefined {
  return FIELD_NOTE[field.key];
}

export function EditScreen(props: EditScreenProps): ReactNode {
  const { seed } = props;
  const creating = seed.mode === "new";
  const setField = (key: string, value: string): void => {
    props.onChange({ ...seed, fields: { ...seed.fields, [key]: value } });
  };

  const row = (field: DraftField): ReactNode => {
    const value = seed.fields[field.key] ?? "";
    const sealed = isSealedField(field);
    const untouched = sealed && value === SEALED;
    const acts = [
      ...(untouched
        ? [{ label: "Replace", run: () => setField(field.key, "") }]
        : []),
      ...(field.key === "password" && !untouched
        ? [{ label: GENERATE, run: props.onGenerate }]
        : []),
    ];
    return (
      <FieldRow
        key={field.key}
        label={field.label}
        {...(fieldNote(field) || untouched
          ? { note: untouched ? SEALED_UNCHANGED : fieldNote(field) }
          : {})}
        {...(field.numeric ? { numeric: true } : {})}
        {...(acts.length > 0 ? { acts } : {})}
      >
        {untouched ? (
          <span
            className={styles.fieldValue}
            data-sealed="true"
            aria-label="Sealed"
          >
            {SEALED_RUN}
          </span>
        ) : field.kind === "long" ? (
          <textarea
            className={`kit-input ${styles.formArea}`}
            rows={3}
            value={value}
            aria-label={field.label}
            onChange={(event) => setField(field.key, event.target.value)}
          />
        ) : (
          <input
            className={`kit-input ${sealed ? styles.gateInput : ""}`}
            type={sealed ? "password" : "text"}
            autoComplete={sealed ? "new-password" : "off"}
            value={value}
            aria-label={field.label}
            onChange={(event) => setField(field.key, event.target.value)}
          />
        )}
      </FieldRow>
    );
  };

  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>
          {creating ? EDIT_HEAD_NEW : EDIT_HEAD_EDIT}
        </h2>
        <p className={styles.lede}>
          {EDIT_LEDE} {EDIT_LEDE_TAIL}
        </p>
      </header>

      {/* THE TYPE, FIRST. On an edit it is a fact rather than a control: the
          vault's `edit_item` rewrites an item's fields, never its type, and a
          chip row that silently did nothing would be the worse lie. */}
      <FieldRow label={TYPE_ROW} note={TYPE_NOTE}>
        {creating ? (
          <span className={styles.chipRow}>
            {ALL_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="kit-chip quiet"
                aria-pressed={seed.type === type}
                onClick={() => props.onRetype(type)}
              >
                {TYPE_LABEL[type]}
              </button>
            ))}
          </span>
        ) : (
          <span className={styles.fieldValue}>{typeLabel(seed.type)}</span>
        )}
      </FieldRow>

      <FieldRow label={TITLE_ROW} note={TITLE_NOTE}>
        <input
          className="kit-input"
          type="text"
          autoComplete="off"
          placeholder={TITLE_PLACEHOLDER}
          aria-label={TITLE_ROW}
          value={seed.title}
          onChange={(event) =>
            props.onChange({ ...seed, title: event.target.value })
          }
        />
      </FieldRow>

      {fieldsFor(seed.type).map(row)}

      {carriesMatchPolicy(seed.type) ? (
        <FieldRow
          label={MATCH_POLICY_ROW}
          note={
            seed.urlMatchPolicy === "exact-host"
              ? MATCH_NOTE_HOST
              : MATCH_NOTE_DOMAIN
          }
        >
          <span className={styles.chipRow}>
            {(
              [
                ["registrable-domain", MATCH_DOMAIN],
                ["exact-host", MATCH_HOST],
              ] as ReadonlyArray<readonly [UrlMatchPolicy, string]>
            ).map(([policy, label]) => (
              <button
                key={policy}
                type="button"
                className="kit-chip quiet"
                aria-pressed={seed.urlMatchPolicy === policy}
                onClick={() =>
                  props.onChange({ ...seed, urlMatchPolicy: policy })
                }
              >
                {label}
              </button>
            ))}
          </span>
        </FieldRow>
      ) : null}

      <FieldRow label={TAGS_ROW} note={TAGS_NOTE}>
        <input
          className="kit-input"
          type="text"
          autoComplete="off"
          placeholder={TAGS_PLACEHOLDER}
          aria-label={TAGS_ROW}
          value={seed.tags}
          onChange={(event) =>
            props.onChange({ ...seed, tags: event.target.value })
          }
        />
      </FieldRow>

      {/* THE ALIAS, READ BACK AND WRITABLE (README-Locker §8's first paper
          cut). The field pre-fills with the binding that exists, emptying it
          clears the binding, and typing another reassigns it — which is the
          whole of what the cut asked for. */}
      <FieldRow label={ALIAS_ROW} note={ALIAS_NOTE}>
        <input
          className="kit-input"
          type="text"
          autoComplete="off"
          placeholder={ALIAS_PLACEHOLDER}
          aria-label={ALIAS_ROW}
          value={seed.alias}
          onChange={(event) =>
            props.onChange({ ...seed, alias: event.target.value })
          }
        />
      </FieldRow>

      {/* The item's own sections and fields, its further addresses and its
          passkey slot. Each is its own act, so each is written where it is
          edited rather than folded into this form's payload. */}
      <EditSidecars
        detail={props.detail}
        draft={props.sidecarDraft}
        onFieldDraft={props.onFieldDraft}
        onFieldSave={props.onFieldSave}
        onFieldRemove={props.onFieldRemove}
        onAddressDraft={props.onAddressDraft}
        onAddressSave={props.onAddressSave}
        onPasskeyDraft={props.onPasskeyDraft}
        onPasskeySave={props.onPasskeySave}
        onPasskeyClear={props.onPasskeyClear}
      />

      {props.error ? (
        <p className={styles.gateError}>{displayText(props.error)}</p>
      ) : null}

      <div className={styles.foot}>
        <span className={styles.footCopy}>
          {props.offline ? EDIT_FOOT_OFFLINE : EDIT_FOOT}
        </span>
        <button
          type="button"
          className="kit-btn quiet"
          onClick={props.onCancel}
        >
          {EDIT_CANCEL}
        </button>
        {/* WITHHELD, never disabled: offline there is nowhere for a secret to
            go, and the foot beside this has already said so. */}
        {props.offline || props.busy ? null : (
          <button
            type="button"
            className="kit-btn primary"
            onClick={props.onSave}
          >
            {EDIT_SAVE}
          </button>
        )}
      </div>
    </section>
  );
}
