import type { ReactNode } from "react";

import { displayText, safeExternalUrl } from "../../_shared/untrusted.ts";
import {
  KIND_LABEL,
  PASSKEY_KEY_FIELD,
  byteSize,
  changedWords,
  sealedFieldKey,
  sectionsOf,
} from "../field-model.ts";
import {
  ADDRESSES_HEAD,
  ADDRESSES_META,
  ADDRESS_OPEN,
  ADDRESS_PRIMARY,
  ARCHIVE,
  ARCHIVED_NO,
  ARCHIVED_ROW,
  ARCHIVED_YES,
  ARCHIVE_NOTE,
  ATTACHMENTS_HEAD,
  ATTACHMENTS_META,
  ATTACHMENTS_NOTE,
  DUPLICATE,
  DUPLICATE_NOTE,
  FIELDS_HEAD,
  FIELDS_META,
  HISTORY_EMPTY,
  HISTORY_HEAD,
  HISTORY_META,
  HISTORY_PASSWORD_PRESENT,
  MATCH_WORD,
  PASSKEY_HEAD,
  PASSKEY_KEY_HELD,
  PASSKEY_KEY_NONE,
  PASSKEY_KEY_ROW,
  PASSKEY_META,
  PASSKEY_SINCE,
  PLAIN_FIELD_NOTE,
  UNARCHIVE,
} from "../item-copy.ts";
import type { LockerDetail } from "../types.ts";
import { FieldRow, SealedField } from "./Fields.tsx";
import { Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export interface SidecarRevealProps {
  revealed: Readonly<Record<string, string>>;
  revealedAt: Readonly<Record<string, number>>;
  now: number;
  onReveal: (field: string) => void;
  onCopy: (field: string) => void;
  onConceal: (field: string) => void;
}

function SidecarSecret({
  label,
  field,
  note,
  reveal,
}: {
  label: string;
  field: string;
  note?: string;
  reveal: SidecarRevealProps;
}): ReactNode {
  const {
    onReveal: handleReveal,
    onCopy: handleCopy,
    onConceal: handleConceal,
  } = reveal;
  return (
    <SealedField
      label={label}
      field={field}
      revealed={reveal.revealed[field] ?? null}
      revealedAt={reveal.revealedAt[field] ?? null}
      now={reveal.now}
      {...(note ? { note } : {})}
      onReveal={handleReveal}
      onCopy={handleCopy}
      onConceal={handleConceal}
    />
  );
}

export function FieldSections({
  detail,
  reveal,
}: {
  detail: LockerDetail;
  reveal: SidecarRevealProps;
}): ReactNode {
  const sections = sectionsOf(detail.fields);
  if (sections.length === 0) return null;
  return (
    <>
      {sections.map((group, index) => (
        <Section
          key={group.section}
          label={group.section}
          {...(index === 0 ? { meta: FIELDS_META } : {})}
          count={group.fields.length}
        >
          {group.fields.map((field) =>
            field.kind === "sealed" ? (
              <SidecarSecret
                key={field.field_id}
                label={field.label}
                field={sealedFieldKey(field.field_id)}
                reveal={reveal}
              />
            ) : (
              <FieldRow
                key={field.field_id}
                label={field.label}
                value={field.value ?? ""}
                note={`${KIND_LABEL[field.kind] ?? field.kind} · ${PLAIN_FIELD_NOTE}`}
                {...(field.kind === "date" || field.kind === "otp"
                  ? { numeric: true }
                  : {})}
              />
            )
          )}
        </Section>
      ))}
    </>
  );
}

export function FieldsHead({ detail }: { detail: LockerDetail }): ReactNode {
  return (detail.fields ?? []).length === 0 ? null : (
    <p className={styles.sectionLabel}>{FIELDS_HEAD}</p>
  );
}

export function AddressSection({
  detail,
  onOpen,
}: {
  detail: LockerDetail;
  onOpen: (url: string) => void;
}): ReactNode {
  const extra = detail.addresses ?? [];
  if (extra.length === 0) return null;
  const rows = [
    ...(detail.url
      ? [
          {
            id: "primary",
            url: detail.url,
            policy: detail.url_match_policy ?? "registrable-domain",
            primary: true,
          },
        ]
      : []),
    ...extra.map((address) => ({
      id: address.address_id,
      url: address.url,
      policy: address.match_policy,
      primary: false,
    })),
  ];
  return (
    <Section label={ADDRESSES_HEAD} meta={ADDRESSES_META} count={rows.length}>
      {rows.map((row) => {
        const safe = safeExternalUrl(row.url);
        return (
          <FieldRow
            key={row.id}
            label={row.primary ? ADDRESS_PRIMARY : ""}
            value={row.url}
            note={MATCH_WORD[row.policy] ?? row.policy}
            {...(safe
              ? { acts: [{ label: ADDRESS_OPEN, run: () => onOpen(safe) }] }
              : {})}
          />
        );
      })}
    </Section>
  );
}

export function PasskeySection({
  detail,
  reveal,
}: {
  detail: LockerDetail;
  reveal: SidecarRevealProps;
}): ReactNode {
  const passkey = detail.passkey;
  if (!passkey) return null;
  const rows: [string, string][] = [
    ["Relying party", passkey.rp_id],
    ...(passkey.display_name ? [["Display name", passkey.display_name]] : []),
    ...(passkey.user_handle ? [["User handle", passkey.user_handle]] : []),
    ...(passkey.credential_id
      ? [["Credential id", passkey.credential_id]]
      : []),
    ...(passkey.algorithm ? [["Algorithm", passkey.algorithm]] : []),
    ...(passkey.created_at
      ? [[PASSKEY_SINCE, passkey.created_at.slice(0, 10)]]
      : []),
  ] as [string, string][];
  return (
    <Section label={PASSKEY_HEAD} meta={PASSKEY_META} count={rows.length + 1}>
      {rows.map(([label, value]) => (
        <FieldRow key={label} label={label} value={value} />
      ))}
      {passkey.has_private_key ? (
        <SidecarSecret
          label={PASSKEY_KEY_ROW}
          field={PASSKEY_KEY_FIELD}
          note={PASSKEY_KEY_HELD}
          reveal={reveal}
        />
      ) : (
        <FieldRow label={PASSKEY_KEY_ROW} note={PASSKEY_KEY_NONE}>
          <span className={styles.fieldValue}>None stored.</span>
        </FieldRow>
      )}
    </Section>
  );
}

export function AttachmentSection({
  detail,
}: {
  detail: LockerDetail;
}): ReactNode {
  const attachments = detail.attachments ?? [];
  if (attachments.length === 0) return null;
  return (
    <Section
      label={ATTACHMENTS_HEAD}
      meta={ATTACHMENTS_META}
      count={attachments.length}
    >
      {attachments.map((file) => (
        <FieldRow
          key={file.attachment_id}
          label={file.title ?? file.role}
          value={[file.media_type, byteSize(file.byte_size)]
            .filter(Boolean)
            .join("  ·  ")}
          note={ATTACHMENTS_NOTE}
        />
      ))}
    </Section>
  );
}

export function HistorySection({
  detail,
}: {
  detail: LockerDetail;
}): ReactNode {
  const history = detail.history ?? [];
  return (
    <Section
      label={HISTORY_HEAD}
      meta={HISTORY_META}
      count={history.length}
      empty={<p className={styles.fieldNote}>{HISTORY_EMPTY}</p>}
    >
      {history.map((revision) => (
        <FieldRow
          key={revision.revision_id}
          label={revision.operation}
          value={[
            changedWords(revision.changed),
            revision.recorded_at.slice(0, 16).replace("T", " "),
          ]
            .filter(Boolean)
            .join("  ·  ")}
          numeric
          {...(revision.changed?.password === true
            ? { note: HISTORY_PASSWORD_PRESENT }
            : {})}
        />
      ))}
    </Section>
  );
}

export function LifeRows({
  detail,
  onArchive,
  onDuplicate,
}: {
  detail: LockerDetail;
  onArchive: () => void;
  onDuplicate: () => void;
}): ReactNode {
  return (
    <>
      <FieldRow
        label={ARCHIVED_ROW}
        value={detail.archived ? ARCHIVED_YES : ARCHIVED_NO}
        note={ARCHIVE_NOTE}
        acts={[
          {
            label: detail.archived ? UNARCHIVE : ARCHIVE,
            run: onArchive,
          },
        ]}
      />
      <FieldRow
        label={DUPLICATE}
        note={DUPLICATE_NOTE}
        acts={[{ label: DUPLICATE, run: onDuplicate }]}
      />
    </>
  );
}

export function degradedText(value: string): string {
  return displayText(value);
}
