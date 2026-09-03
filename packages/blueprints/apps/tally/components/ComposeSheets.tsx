import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import {
  DELETE_GROUP_BODY,
  DELETE_GROUP_COMMIT,
  DELETE_GROUP_HEAD,
  FIELD_KEYS,
  FRIEND_BODY,
  FRIEND_COMMIT,
  FRIEND_HEAD,
  GROUP_BODY,
  GROUP_COLOURS,
  GROUP_COMMIT,
  GROUP_HEAD,
  GROUP_ICONS,
  MEMBER_BODY,
  MEMBER_COMMIT,
  MEMBER_HEAD,
  MEMBER_NONE,
  PLACEHOLDERS,
  RENAME_COMMIT,
  RENAME_HEAD,
  TRASH_BODY,
  TRASH_TITLE,
} from "../compose-copy.ts";
import type { Person } from "../types.ts";
import { VERBS } from "../view-copy.ts";
import { ChipSet, InlineInput } from "./Fields.tsx";
import { Confirm, FormSheet } from "./Panels.tsx";

import styles from "./Compose.module.css";

export type ComposeOverlay =
  | { kind: "friend"; name: string }
  | {
      kind: "group";
      name: string;
      icon: string;
      color: string;
      memberIds: string[];
    }
  | { kind: "rename"; groupId: string; name: string }
  | { kind: "member"; groupId: string; partyId: string }
  | { kind: "deleteGroup"; groupId: string; name: string; refused: boolean }
  | { kind: "trash"; expenseId: string };

export interface ComposeSheetsProps {
  overlay: ComposeOverlay;
  friends: readonly Person[];
  candidates: readonly Person[];
  onName: (value: string) => void;
  onIcon: (id: string) => void;
  onColour: (id: string) => void;
  onToggleMember: (partyId: string) => void;
  onPickMember: (partyId: string) => void;
  onClose: () => void;
  onCommit: () => void;
}

const NAME_REQUIRED = "A name";
const MEMBER_REQUIRED = "Someone to add";

export function ComposeSheets(props: ComposeSheetsProps): ReactNode {
  const open = props.overlay;

  if (open.kind === "friend") {
    return (
      <FormSheet
        title={FRIEND_HEAD}
        body={FRIEND_BODY}
        commitLabel={FRIEND_COMMIT}
        {...(open.name.trim() === "" ? { disabledReason: NAME_REQUIRED } : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onCommit={props.onCommit}
      >
        <div className={styles.sheetForm}>
          <label className={styles.sheetLabel} htmlFor="tally-friend-name">
            {FIELD_KEYS.name}
          </label>
          <InlineInput
            id="tally-friend-name"
            label={FIELD_KEYS.name}
            value={open.name}
            placeholder={PLACEHOLDERS.friend}
            onChange={props.onName}
          />
        </div>
      </FormSheet>
    );
  }

  if (open.kind === "group") {
    return (
      <FormSheet
        title={GROUP_HEAD}
        body={GROUP_BODY}
        commitLabel={GROUP_COMMIT}
        {...(open.name.trim() === "" ? { disabledReason: NAME_REQUIRED } : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onCommit={props.onCommit}
      >
        <div className={styles.sheetForm}>
          <label className={styles.sheetLabel} htmlFor="tally-group-name">
            {FIELD_KEYS.name}
          </label>
          <InlineInput
            id="tally-group-name"
            label={FIELD_KEYS.name}
            value={open.name}
            placeholder={PLACEHOLDERS.group}
            onChange={props.onName}
          />
          <span className={styles.sheetLabel}>{FIELD_KEYS.icon}</span>
          <ChipSet
            options={GROUP_ICONS.map(([id, label]) => ({ id, label }))}
            value={open.icon}
            label={FIELD_KEYS.icon}
            onPick={props.onIcon}
          />
          <span className={styles.sheetLabel}>{FIELD_KEYS.colour}</span>
          <ChipSet
            options={GROUP_COLOURS.map(([id, label]) => ({ id, label }))}
            value={open.color}
            label={FIELD_KEYS.colour}
            onPick={props.onColour}
          />
          <span className={styles.sheetLabel}>{FIELD_KEYS.members}</span>
          {/* A multi-choice set, so every chip carries its own pressed state
              rather than the group carrying one selection. */}
          <fieldset className={styles.chips} aria-label={FIELD_KEYS.members}>
            {props.friends.map((friend) => (
              <button
                key={friend.party_id}
                type="button"
                className="kit-chip"
                aria-pressed={open.memberIds.includes(friend.party_id)}
                onClick={() => props.onToggleMember(friend.party_id)}
              >
                {displayText(friend.name)}
              </button>
            ))}
          </fieldset>
        </div>
      </FormSheet>
    );
  }

  if (open.kind === "rename") {
    return (
      <FormSheet
        title={RENAME_HEAD}
        commitLabel={RENAME_COMMIT}
        {...(open.name.trim() === "" ? { disabledReason: NAME_REQUIRED } : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onCommit={props.onCommit}
      >
        <div className={styles.sheetForm}>
          <label className={styles.sheetLabel} htmlFor="tally-rename">
            {FIELD_KEYS.name}
          </label>
          <InlineInput
            id="tally-rename"
            label={FIELD_KEYS.name}
            value={open.name}
            onChange={props.onName}
          />
        </div>
      </FormSheet>
    );
  }

  if (open.kind === "member") {
    const none = props.candidates.length === 0;
    return (
      <FormSheet
        title={MEMBER_HEAD}
        body={none ? MEMBER_NONE : MEMBER_BODY}
        commitLabel={MEMBER_COMMIT}
        {...(open.partyId === ""
          ? { disabledReason: none ? MEMBER_NONE : MEMBER_REQUIRED }
          : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onCommit={props.onCommit}
      >
        <div className={styles.sheetForm}>
          <ChipSet
            options={props.candidates.map((person) => ({
              id: person.party_id,
              label: person.name,
            }))}
            value={open.partyId === "" ? null : open.partyId}
            label={FIELD_KEYS.members}
            onPick={props.onPickMember}
          />
        </div>
      </FormSheet>
    );
  }

  if (open.kind === "deleteGroup") {
    return (
      <Confirm
        title={DELETE_GROUP_HEAD}
        body={DELETE_GROUP_BODY}
        commitLabel={DELETE_GROUP_COMMIT}
        destructive
        {...(open.refused ? { disabledReason: DELETE_GROUP_BODY } : {})}
        cancelLabel={VERBS.close}
        onCancel={props.onClose}
        onConfirm={props.onCommit}
      />
    );
  }

  return (
    <Confirm
      title={TRASH_TITLE}
      body={TRASH_BODY}
      commitLabel={VERBS.trash}
      destructive
      cancelLabel={VERBS.close}
      onCancel={props.onClose}
      onConfirm={props.onCommit}
    />
  );
}
