// ADD / EDIT (README-Locker §1, §5; FLOWS.md "Add / edit each type").
//
// THE TYPE CHIP IS THE FIRST CONTROL AND IT DECIDES THE FIELDS. The set is
// `draft.ts`'s table rather than a chain of conditionals here, so a card is
// never asked for a username and a type the vault gains later is one row of
// data.
//
// THE ONLINE-ONLY RULE IS IN THE LEDE, NOT AT THE COMMIT. A member finds out
// that creating or editing a secret needs the gateway before they type, which
// is the difference between a designed refusal and a discovered one — and
// offline the commit is WITHHELD rather than disabled, with the reason in its
// place (no disabled button anywhere in this app).
//
// NOTHING ON THIS FORM IS HELD IN `useState`. Every keystroke lands in the
// orchestrator's `editSeed`, which is one of the enumerated secret-bearing
// fields a lock erases (session.ts `SECRET_BEARING_KEYS`) — a half-typed
// password in component state would be a value React may retain across a
// suspended render, and the whole boundary would have a hole in it.
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
import {
  ALIAS_NONE,
  ALIAS_NOTE,
  ALIAS_ROW,
  CONNECTION_NONE,
  CONNECTION_NOTE,
  CONNECTION_ROW,
  CUSTOM_NOTE,
  CUSTOM_ROW,
  CUSTOM_VALUE,
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
import type {
  ItemDraftSeed,
  LockerItemType,
  UrlMatchPolicy,
} from "../types.ts";
import { EDIT_LEDE, GENERATE, TYPE_LABEL, TYPE_ORDER } from "../view-copy.ts";
import { FieldRow } from "./Fields.tsx";

import styles from "./Rows.module.css";

/** The dot run a stored secret wears on this form. The same run the item
 *  screen draws, for the same reason: its length never tracks the secret's. */
const SEALED_RUN = "••••••••••••••";

export interface EditScreenProps {
  seed: ItemDraftSeed;
  /** The gateway is out of reach, so a secret write has nowhere to land. */
  offline: boolean;
  /** A save is in flight — the commit says so by being absent, not by a
   *  spinner and not by a disabled control. */
  busy: boolean;
  /** What the form itself refused, in its own words. */
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

  /** One typed row. A sealed field whose stored value the member has not
   *  replaced draws the run and says it is unchanged — it never shows the
   *  vault's placeholder as if it were a value. */
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
            {TYPE_ORDER.map((type) => (
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

      {/* Three rows drawn where they belong and inert where the backend is
          not there yet. Each carries its own tag, so a reviewer reading the
          screen sees the scope without reading the gap register. */}
      <FieldRow label={CUSTOM_ROW} value={CUSTOM_VALUE} note={CUSTOM_NOTE} />
      <FieldRow
        label={CONNECTION_ROW}
        value={CONNECTION_NONE}
        note={CONNECTION_NOTE}
      />
      <FieldRow label={ALIAS_ROW} value={ALIAS_NONE} note={ALIAS_NOTE} />

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
