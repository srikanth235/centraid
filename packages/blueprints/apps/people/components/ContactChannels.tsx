import { useState } from "react";

import { armConfirm } from "../kit.ts";
import type { Contact, DetailPerson } from "../types.ts";

import styles from "./ContactChannels.module.css";
import detailStyles from "./DetailSections.module.css";

type ChannelKind = Contact["kind"];

export function ContactChannels({
  person,
  onSave,
  onDelete,
}: {
  person: DetailPerson;
  onSave: (fields: Record<string, unknown>) => Promise<boolean>;
  onDelete: (channelId: string) => void;
}) {
  const [editing, setEditing] = useState<Contact | null>(null);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<ChannelKind>("phone");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [preferred, setPreferred] = useState(false);
  const openForm = adding || editing != null;

  const reset = () => {
    setAdding(false);
    setEditing(null);
    setKind("phone");
    setLabel("");
    setValue("");
    setPreferred(false);
  };
  const edit = (contact: Contact) => {
    if (!contact.channel_id) return;
    setAdding(false);
    setEditing(contact);
    setKind(contact.kind);
    setLabel(contact.label ?? "");
    setValue(contact.value);
    setPreferred(Boolean(contact.preferred));
  };

  return (
    <>
      <div className={styles.sectionHead}>
        <div className={detailStyles.detailLabel}>Contact channels</div>
        <button
          type="button"
          className="kit-btn"
          onClick={() => {
            reset();
            setAdding(true);
          }}
        >
          + add
        </button>
      </div>
      <div className={styles.list}>
        {(person.contact ?? []).map((contact, index) => (
          <div
            className={styles.row}
            key={contact.channel_id ?? `legacy-${contact.kind}-${index}`}
          >
            <div>
              <div className={styles.value}>
                {contact.preferred ? "★ " : ""}
                {contact.value}
              </div>
              <div className={styles.meta}>
                {contact.label ? `${contact.label} · ` : ""}
                {contact.kind}
                {contact.legacy
                  ? " · legacy identifier"
                  : contact.provenance?.source
                    ? ` · ${String(contact.provenance.source)}`
                    : " · manual"}
              </div>
            </div>
            {contact.channel_id ? (
              <div className={styles.actions}>
                <button
                  type="button"
                  className="kit-btn"
                  onClick={() => edit(contact)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="kit-btn danger"
                  onClick={(event) => {
                    if (
                      !armConfirm(event.currentTarget, {
                        armedLabel: "Delete channel?",
                      })
                    )
                      return;
                    onDelete(contact.channel_id!);
                  }}
                >
                  Delete
                </button>
              </div>
            ) : null}
            {(contact.duplicate_names?.length ?? 0) > 0 ? (
              <output className={styles.warning}>
                Possible duplicate: also used by{" "}
                {contact.duplicate_names!.join(", ")}. Review before merging.
              </output>
            ) : null}
          </div>
        ))}
      </div>
      {openForm ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({
              ...(editing?.channel_id
                ? { channel_id: editing.channel_id }
                : {}),
              kind,
              label: label.trim(),
              value: value.trim(),
              preferred,
              provenance: {
                source: "manual",
                entered_via: "people",
              },
            }).then((saved) => {
              if (saved) reset();
            });
          }}
        >
          <label>
            Type
            <select
              className="kit-input"
              value={kind}
              onChange={(event) =>
                setKind(event.currentTarget.value as ChannelKind)
              }
            >
              <option value="phone">Phone</option>
              <option value="email">Email</option>
              <option value="address">Address</option>
              <option value="handle">Handle</option>
            </select>
          </label>
          <label>
            Label
            <input
              className="kit-input"
              value={label}
              placeholder="home, work…"
              onChange={(event) => setLabel(event.currentTarget.value)}
            />
          </label>
          <label className={styles.wide}>
            Value
            <input
              className="kit-input"
              value={value}
              required
              autoFocus
              onChange={(event) => setValue(event.currentTarget.value)}
            />
          </label>
          <label className={styles.preferred}>
            <input
              type="checkbox"
              checked={preferred}
              onChange={(event) => setPreferred(event.currentTarget.checked)}
            />
            Preferred {kind}
          </label>
          <div className={styles.actions}>
            <button type="button" className="kit-btn" onClick={reset}>
              Cancel
            </button>
            <button
              type="submit"
              className="kit-btn primary"
              disabled={!value.trim()}
            >
              Save
            </button>
          </div>
        </form>
      ) : null}
    </>
  );
}
