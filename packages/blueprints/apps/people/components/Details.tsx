// The profile drawer shell (#detailsRoot root) — a dumb projection: `person`
// is the freshly-read PERSON (or null while the shell shows), `adders` is a
// snapshot of which "+ add" affordances are open. Every write flows out
// through the `on*` callback props into app.tsx's `drawerAct`/`toggleStar`/
// `logInteraction`; this component never calls the vault itself. Body
// sections live in DetailSections.tsx (kept separate to stay under the
// file-size cap); the "+ add" mini-forms live in AddRows.tsx.
import { useState } from "react";

import { I } from "../icons.ts";
import { armConfirm } from "../kit.ts";
import type { DetailPerson, Person } from "../types.ts";
import { Sections } from "./DetailSections.tsx";
import { History } from "./History.tsx";
import { Icon, KitAvatar } from "./Shared.tsx";

import styles from "./Details.module.css";
import shared from "./shared.module.css";

export interface DrawerCallbacks {
  onMessage: () => void;
  onCall: () => void;
  onToggleStar: () => void;
  onToggleAdder: (key: string) => void;
  onAddRelationship: (fields: Record<string, unknown>) => Promise<boolean>;
  onAddDate: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleReminder: (dateId: string) => void;
  onAddTask: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleTask: (taskId: string) => void;
  onAddNote: (fields: Record<string, unknown>) => Promise<boolean>;
  onAddGift: (fields: Record<string, unknown>) => Promise<boolean>;
  onToggleGift: (giftId: string) => void;
  onAddDebt: (fields: Record<string, unknown>) => Promise<boolean>;
  onSettleDebt: (debtId: string) => void;
  onSaveContact: (fields: Record<string, unknown>) => Promise<boolean>;
  onDeleteContact: (channelId: string) => void;
}

export function Details({
  person,
  nameGuess,
  color,
  adders,
  onClose,
  onMove,
  onEdit,
  onSetCadence,
  onTrash,
  onUndo,
  mergeCandidates,
  onMerge,
  ...callbacks
}: {
  person: DetailPerson | null;
  nameGuess: string;
  color: string;
  adders: Record<string, boolean>;
  onClose: () => void;
  onMove: (anchor: HTMLElement) => void;
  onEdit: (fields: Record<string, unknown>) => Promise<boolean>;
  onSetCadence: (cadenceDays: number) => Promise<boolean>;
  onTrash: () => void;
  onUndo: (revisionId: string) => void;
  mergeCandidates: Person[];
  onMerge: (targetPartyId: string) => void;
} & DrawerCallbacks) {
  const dp = person;
  const [editing, setEditing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [name, setName] = useState(nameGuess);
  const [role, setRole] = useState(dp?.role ?? "");
  const [met, setMet] = useState(dp?.met ?? "");
  const [cadence, setCadence] = useState(dp?.cadence_days ?? 30);
  const [mergeTarget, setMergeTarget] = useState("");
  return (
    <>
      <button
        type="button"
        className={`kit-plain-btn ${styles.detailsBackdrop}`}
        aria-label="Close"
        onClick={onClose}
      />
      <dialog
        open
        className={styles.details}
        aria-modal="true"
        aria-label="Profile"
      >
        <div className={styles.detailsHead}>
          <span className={styles.lbl}>Profile</span>
          <button
            type="button"
            className={styles.detailsX}
            aria-label="Close"
            onClick={onClose}
          >
            <Icon svg={I.close} />
          </button>
        </div>
        <div className={styles.detailsBody}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                borderRadius: "999px",
                boxShadow: `0 8px 22px -6px color-mix(in oklab, ${color} 60%, transparent)`,
              }}
            >
              <KitAvatar name={nameGuess} size="72px" color={color} />
            </span>
          </div>
          {editing ? (
            <form
              className={styles.profileForm}
              onSubmit={(event) => {
                event.preventDefault();
                void onEdit({
                  display_name: name.trim(),
                  role: role.trim(),
                  met: met.trim(),
                }).then((saved) => {
                  if (saved) setEditing(false);
                });
              }}
            >
              <label>
                Name
                <input
                  className="kit-input"
                  value={name}
                  required
                  onChange={(event) => setName(event.currentTarget.value)}
                />
              </label>
              <label>
                Role
                <input
                  className="kit-input"
                  value={role}
                  onChange={(event) => setRole(event.currentTarget.value)}
                />
              </label>
              <label>
                How you met
                <input
                  className="kit-input"
                  value={met}
                  onChange={(event) => setMet(event.currentTarget.value)}
                />
              </label>
              <div className={styles.profileActions}>
                <button
                  type="button"
                  className="kit-btn"
                  onClick={() => setEditing(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="kit-btn primary"
                  disabled={!name.trim()}
                >
                  Save profile
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className={styles.detailName}>{nameGuess}</div>
              <div className={styles.detailExt}>{dp?.role || ""}</div>
            </>
          )}
          {dp ? (
            <>
              <div className={styles.profileTools}>
                <button
                  type="button"
                  className="kit-btn"
                  onClick={() => setEditing(true)}
                >
                  Edit profile
                </button>
                <label>
                  Keep in touch every
                  <select
                    className="kit-input"
                    value={cadence}
                    onChange={(event) => {
                      const days = Number(event.currentTarget.value);
                      setCadence(days);
                      void onSetCadence(days);
                    }}
                  >
                    {[7, 14, 30, 60, 90, 180, 365].map((days) => (
                      <option value={days} key={days}>
                        {days} days
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Sections dp={dp} color={color} adders={adders} {...callbacks} />
              <button
                type="button"
                className="kit-btn"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                {historyOpen ? "Hide history" : "Change history"}
              </button>
              {historyOpen ? (
                <History partyId={dp.party_id} onUndo={onUndo} />
              ) : null}
            </>
          ) : null}
        </div>
        <div className={styles.detailsFoot}>
          {dp ? (
            <>
              <button
                type="button"
                className={`kit-btn ${shared.detailBtn}`}
                onClick={(e) => onMove(e.currentTarget)}
              >
                Move to list
              </button>
              <button
                type="button"
                className="kit-btn danger"
                onClick={(event) => {
                  if (
                    !armConfirm(event.currentTarget, {
                      armedLabel: `Delete ${dp.name}?`,
                    })
                  )
                    return;
                  onTrash();
                }}
              >
                Delete person
              </button>
              <select
                className="kit-input"
                aria-label="Merge this person into"
                value={mergeTarget}
                onChange={(event) => setMergeTarget(event.currentTarget.value)}
              >
                <option value="">Merge duplicate into…</option>
                {mergeCandidates.map((person2) => (
                  <option key={person2.party_id} value={person2.party_id}>
                    {person2.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="kit-btn danger"
                disabled={!mergeTarget}
                onClick={(event) => {
                  if (
                    !armConfirm(event.currentTarget, {
                      armedLabel: "Confirm merge?",
                    })
                  )
                    return;
                  onMerge(mergeTarget);
                }}
              >
                Merge duplicate
              </button>
            </>
          ) : null}
        </div>
      </dialog>
    </>
  );
}
