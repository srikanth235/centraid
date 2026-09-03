import type { ReactNode } from "react";

import { SEALED } from "../draft.ts";
import { FIELD_KINDS, KIND_LABEL, sectionsOf } from "../field-model.ts";
import { SEALED_RUN } from "../item-fields.ts";
import {
  ADDRESSES_ADD,
  ADDRESSES_NONE,
  ADDRESSES_NOTE,
  ADDRESSES_PLACEHOLDER,
  ADDRESSES_REMOVE,
  ADDRESSES_REPLACE_NOTE,
  ADDRESSES_ROW,
  ADDRESSES_SAVE,
  CUSTOM_ADD,
  CUSTOM_KIND_ROW,
  CUSTOM_LABEL_PLACEHOLDER,
  CUSTOM_LABEL_ROW,
  CUSTOM_NONE,
  CUSTOM_NOTE,
  CUSTOM_REMOVE,
  CUSTOM_ROW,
  CUSTOM_SAVE,
  CUSTOM_SECTION_PLACEHOLDER,
  CUSTOM_SECTION_ROW,
  CUSTOM_VALUE_ROW,
  MATCH_DOMAIN,
  MATCH_HOST,
  PASSKEY_ALGORITHM,
  PASSKEY_CLEAR,
  PASSKEY_CREDENTIAL,
  PASSKEY_DISPLAY,
  PASSKEY_HANDLE,
  PASSKEY_KEY,
  PASSKEY_NONE,
  PASSKEY_NOTE,
  PASSKEY_ROW,
  PASSKEY_RP,
  PASSKEY_SAVE,
} from "../route-copy.ts";
import type { SidecarDraft } from "../session.ts";
import type { LockerDetail, UrlMatchPolicy } from "../types.ts";
import { FieldRow } from "./Fields.tsx";

import styles from "./Rows.module.css";

export interface SidecarActs {
  onFieldDraft: (draft: SidecarDraft["field"]) => void;
  onFieldSave: () => void;
  onFieldRemove: (fieldId: string) => void;
  onAddressDraft: (draft: SidecarDraft["addresses"]) => void;
  onAddressSave: () => void;
  onPasskeyDraft: (draft: SidecarDraft["passkey"]) => void;
  onPasskeySave: () => void;
  onPasskeyClear: () => void;
}

export interface EditSidecarsProps extends SidecarActs {
  detail: LockerDetail | null;
  draft: SidecarDraft;
}

function textRow(
  label: string,
  value: string,
  placeholder: string,
  onChange: (next: string) => void,
  sealed = false
): ReactNode {
  return (
    <FieldRow key={label} label={label}>
      <input
        className={`kit-input ${sealed ? styles.gateInput : ""}`}
        type={sealed ? "password" : "text"}
        autoComplete={sealed ? "new-password" : "off"}
        placeholder={placeholder}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldRow>
  );
}

function FieldDraft({
  draft,
  onFieldDraft,
  onFieldSave,
}: {
  draft: NonNullable<SidecarDraft["field"]>;
} & Pick<SidecarActs, "onFieldDraft" | "onFieldSave">): ReactNode {
  const sealed = draft.kind === "sealed";
  const untouched = sealed && draft.value === SEALED;
  return (
    <>
      {textRow(
        CUSTOM_SECTION_ROW,
        draft.section,
        CUSTOM_SECTION_PLACEHOLDER,
        (section) => onFieldDraft({ ...draft, section })
      )}
      {textRow(
        CUSTOM_LABEL_ROW,
        draft.label,
        CUSTOM_LABEL_PLACEHOLDER,
        (label) => onFieldDraft({ ...draft, label })
      )}
      <FieldRow label={CUSTOM_KIND_ROW}>
        <span className={styles.chipRow}>
          {FIELD_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="kit-chip quiet"
              aria-pressed={draft.kind === kind}
              onClick={() => onFieldDraft({ ...draft, kind })}
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        </span>
      </FieldRow>
      <FieldRow
        label={CUSTOM_VALUE_ROW}
        {...(untouched
          ? {
              note: "Left as it is · type here only to replace the stored secret",
            }
          : {})}
        acts={[{ label: CUSTOM_SAVE, run: onFieldSave }]}
      >
        {untouched ? (
          <span
            className={styles.fieldValue}
            data-sealed="true"
            aria-label="Sealed"
          >
            {SEALED_RUN}
          </span>
        ) : (
          <input
            className={`kit-input ${sealed ? styles.gateInput : ""}`}
            type={sealed ? "password" : "text"}
            autoComplete={sealed ? "new-password" : "off"}
            aria-label={CUSTOM_VALUE_ROW}
            value={draft.value}
            onChange={(event) =>
              onFieldDraft({ ...draft, value: event.target.value })
            }
          />
        )}
      </FieldRow>
    </>
  );
}

export function EditSidecars(props: EditSidecarsProps): ReactNode {
  const { detail, draft } = props;
  if (!detail) {
    return (
      <FieldRow
        label={CUSTOM_ROW}
        note={`${CUSTOM_NOTE} They are edited on an item that exists, so this opens once it is saved.`}
      />
    );
  }

  const sections = sectionsOf(detail.fields);
  const addresses =
    draft.addresses ??
    (detail.addresses ?? []).map((address) => ({
      url: address.url,
      matchPolicy: address.match_policy,
    }));
  const passkey =
    draft.passkey ??
    (detail.passkey
      ? {
          rpId: detail.passkey.rp_id,
          userHandle: detail.passkey.user_handle ?? "",
          displayName: detail.passkey.display_name ?? "",
          credentialId: detail.passkey.credential_id ?? "",
          algorithm: detail.passkey.algorithm ?? "",
          privateKey: "",
        }
      : null);

  return (
    <>
      <FieldRow
        label={CUSTOM_ROW}
        note={CUSTOM_NOTE}
        acts={[
          {
            label: CUSTOM_ADD,
            run: () =>
              props.onFieldDraft({
                section: "",
                label: "",
                kind: "text",
                value: "",
              }),
          },
        ]}
      >
        {sections.length === 0 ? (
          <span className={styles.fieldValue}>{CUSTOM_NONE}</span>
        ) : null}
      </FieldRow>

      {sections.flatMap((group) =>
        group.fields.map((field) => (
          <FieldRow
            key={field.field_id}
            label={`${group.section} · ${field.label}`}
            value={field.kind === "sealed" ? null : (field.value ?? "")}
            note={KIND_LABEL[field.kind] ?? field.kind}
            acts={[
              {
                label: "Edit",
                run: () =>
                  props.onFieldDraft({
                    fieldId: field.field_id,
                    section: field.section,
                    label: field.label,
                    kind: field.kind,
                    value:
                      field.kind === "sealed" ? SEALED : (field.value ?? ""),
                  }),
              },
              {
                label: CUSTOM_REMOVE,
                run: () => props.onFieldRemove(field.field_id),
              },
            ]}
          >
            {field.kind === "sealed" ? (
              <span
                className={styles.fieldValue}
                data-sealed="true"
                aria-label="Sealed"
              >
                {SEALED_RUN}
              </span>
            ) : null}
          </FieldRow>
        ))
      )}

      {draft.field ? (
        <FieldDraft
          draft={draft.field}
          onFieldDraft={props.onFieldDraft}
          onFieldSave={props.onFieldSave}
        />
      ) : null}

      {detail.type === "login" ? (
        <>
          <FieldRow
            label={ADDRESSES_ROW}
            note={`${ADDRESSES_NOTE} ${ADDRESSES_REPLACE_NOTE}`}
            acts={[
              {
                label: ADDRESSES_ADD,
                run: () =>
                  props.onAddressDraft([
                    ...addresses,
                    { url: "", matchPolicy: "registrable-domain" },
                  ]),
              },
              { label: ADDRESSES_SAVE, run: props.onAddressSave },
            ]}
          >
            {addresses.length === 0 ? (
              <span className={styles.fieldValue}>{ADDRESSES_NONE}</span>
            ) : null}
          </FieldRow>
          {addresses.map((address, index) => (
            <FieldRow
              key={`address-${index}`}
              label=""
              acts={[
                {
                  label: ADDRESSES_REMOVE,
                  run: () =>
                    props.onAddressDraft(
                      addresses.filter((_, at) => at !== index)
                    ),
                },
              ]}
            >
              <span className={styles.chipRow}>
                <input
                  className="kit-input"
                  type="text"
                  autoComplete="off"
                  placeholder={ADDRESSES_PLACEHOLDER}
                  aria-label={`${ADDRESSES_ROW} ${index + 1}`}
                  value={address.url}
                  onChange={(event) =>
                    props.onAddressDraft(
                      addresses.map((row, at) =>
                        at === index ? { ...row, url: event.target.value } : row
                      )
                    )
                  }
                />
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
                    aria-pressed={address.matchPolicy === policy}
                    onClick={() =>
                      props.onAddressDraft(
                        addresses.map((row, at) =>
                          at === index ? { ...row, matchPolicy: policy } : row
                        )
                      )
                    }
                  >
                    {label}
                  </button>
                ))}
              </span>
            </FieldRow>
          ))}
        </>
      ) : null}

      <FieldRow
        label={PASSKEY_ROW}
        note={PASSKEY_NOTE}
        acts={
          passkey
            ? [
                { label: PASSKEY_SAVE, run: props.onPasskeySave },
                { label: PASSKEY_CLEAR, run: props.onPasskeyClear },
              ]
            : [
                {
                  label: PASSKEY_SAVE,
                  run: () =>
                    props.onPasskeyDraft({
                      rpId: "",
                      userHandle: "",
                      displayName: "",
                      credentialId: "",
                      algorithm: "",
                      privateKey: "",
                    }),
                },
              ]
        }
      >
        {passkey ? null : (
          <span className={styles.fieldValue}>{PASSKEY_NONE}</span>
        )}
      </FieldRow>

      {passkey
        ? [
            textRow(PASSKEY_RP, passkey.rpId, "example.test", (rpId) =>
              props.onPasskeyDraft({ ...passkey, rpId })
            ),
            textRow(PASSKEY_DISPLAY, passkey.displayName, "", (displayName) =>
              props.onPasskeyDraft({ ...passkey, displayName })
            ),
            textRow(PASSKEY_HANDLE, passkey.userHandle, "", (userHandle) =>
              props.onPasskeyDraft({ ...passkey, userHandle })
            ),
            textRow(
              PASSKEY_CREDENTIAL,
              passkey.credentialId,
              "",
              (credentialId) =>
                props.onPasskeyDraft({ ...passkey, credentialId })
            ),
            textRow(
              PASSKEY_ALGORITHM,
              passkey.algorithm,
              "ES256",
              (algorithm) => props.onPasskeyDraft({ ...passkey, algorithm })
            ),
            textRow(
              PASSKEY_KEY,
              passkey.privateKey,
              "",
              (privateKey) => props.onPasskeyDraft({ ...passkey, privateKey }),
              true
            ),
          ]
        : null}
    </>
  );
}
