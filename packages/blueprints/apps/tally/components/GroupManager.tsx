import { useMemo, useState } from "react";

import { AudiencePlacement } from "../../_shared/AudiencePlacement.tsx";
import type { Friend, GroupMeta, Member } from "../types.ts";
import { ArmedButton, KitAvatar } from "./Shared.tsx";

import styles from "./GroupManager.module.css";

export function GroupManager({
  group,
  members,
  friends,
  me,
  onRename,
  onAddMember,
  onRemoveMember,
  onDelete,
}: {
  group: GroupMeta;
  members: Member[];
  friends: Friend[];
  me: string | null;
  onRename: (groupId: string, name: string) => void;
  onAddMember: (groupId: string, partyId: string) => void;
  onRemoveMember: (groupId: string, partyId: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(group.name);
  const available = useMemo(() => {
    const present = new Set(members.map((member) => member.party_id));
    return friends.filter((friend) => !present.has(friend.party_id));
  }, [friends, members]);
  const [partyId, setPartyId] = useState("");

  if (!open) {
    return (
      <div className={styles.heading}>
        <h3>Group ledger</h3>
        <button type="button" className="kit-btn" onClick={() => setOpen(true)}>
          Manage group
        </button>
      </div>
    );
  }

  return (
    <section className={styles.card} aria-label="Manage group">
      <div className={styles.heading}>
        <h3>Manage group</h3>
        <button
          type="button"
          className="kit-btn"
          onClick={() => setOpen(false)}
        >
          Done
        </button>
      </div>
      <div className={styles.rename}>
        <input
          aria-label="Group name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          type="button"
          className="kit-btn"
          disabled={!name.trim() || name.trim() === group.name}
          onClick={() => onRename(group.group_id, name.trim())}
        >
          Rename
        </button>
      </div>
      <div className={styles.members}>
        {members.map((member) => (
          <div className={styles.member} key={member.party_id}>
            <KitAvatar
              name={member.name}
              size="28px"
              color={member.color}
              initials={member.initials}
            />
            <span>{member.party_id === me ? "You" : member.name}</span>
            {member.party_id === me ? null : (
              <ArmedButton
                className="kit-btn danger"
                label="Remove"
                armedLabel={`Remove ${member.name}?`}
                onConfirm={() =>
                  onRemoveMember(group.group_id, member.party_id)
                }
              />
            )}
          </div>
        ))}
      </div>
      {available.length > 0 ? (
        <div className={styles.add}>
          <select
            aria-label="Friend to add"
            value={partyId}
            onChange={(event) => setPartyId(event.target.value)}
          >
            <option value="">Choose a friend…</option>
            {available.map((friend) => (
              <option key={friend.party_id} value={friend.party_id}>
                {friend.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="kit-btn"
            disabled={!partyId}
            onClick={() => {
              onAddMember(group.group_id, partyId);
              setPartyId("");
            }}
          >
            Add member
          </button>
        </div>
      ) : (
        <p className={styles.hint}>Every Tally friend is already a member.</p>
      )}
      <p className={styles.hint}>
        Members on an expense cannot be removed. A group can be deleted only
        after all of its expenses leave the trash grace window.
      </p>
      <AudiencePlacement itemType="tally.group" itemId={group.group_id} />
      <div className={styles.danger}>
        <ArmedButton
          className="kit-btn danger"
          label="Delete group"
          armedLabel={`Delete ${group.name}?`}
          onConfirm={() => onDelete(group.group_id)}
        />
      </div>
    </section>
  );
}
