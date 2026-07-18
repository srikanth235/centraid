// The new-group form: name, an icon picker and a friend-multiselect for
// members. `ng` is app.tsx's mutable `state.newGroup`; `onPatch` mutates it
// in place and re-renders, same pattern as ExpenseModal's `onPatch`.
import { GROUP_ICONS, first } from '../format.ts';
import type { Friend, NewGroupModel } from '../types.ts';
import { ModalBackdrop } from './Shared.tsx';
import styles from './GroupModal.module.css';
import shared from './shared.module.css';

export function GroupModal({
  ng,
  friends,
  onPatch,
  onClose,
  onSave,
}: {
  ng: NewGroupModel;
  friends: Friend[];
  onPatch: (patch: Partial<NewGroupModel>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const valid = Boolean(ng.name.trim() && ng.members.size >= 1);

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
        <h2>New group</h2>
        <input
          className={shared.in}
          style={{ fontSize: '15px' }}
          value={ng.name}
          placeholder="Group name"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <div className={shared.field}>
          <div className={shared.flabel}>Icon</div>
          <div className={shared.catrow}>
            {GROUP_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                className="kit-chip quiet"
                aria-pressed={ng.icon === ic}
                onClick={() => onPatch({ icon: ic })}
              >
                {ic}
              </button>
            ))}
          </div>
        </div>
        <div className={shared.field}>
          <div className={shared.flabel}>Members</div>
          <div className={styles.memtoggle}>
            {friends.map((f) => {
              const on = ng.members.has(f.party_id);
              return (
                <button
                  key={f.party_id}
                  type="button"
                  className="kit-chip quiet"
                  aria-pressed={on}
                  onClick={() => {
                    const next = new Set(ng.members);
                    if (on) next.delete(f.party_id);
                    else next.add(f.party_id);
                    onPatch({ members: next });
                  }}
                >
                  <span
                    style={{
                      width: '9px',
                      height: '9px',
                      borderRadius: '999px',
                      background: f.color,
                    }}
                  />
                  {first(f.name)}
                </button>
              );
            })}
          </div>
        </div>
        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kit-btn primary" disabled={!valid} onClick={onSave}>
            Create group
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
