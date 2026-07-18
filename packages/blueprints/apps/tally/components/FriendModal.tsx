// The add-friend form: just a name. A friend's avatar hue is derived from the
// party (issue #441 A3), not chosen and stored per Tally row, so there is no
// colour picker. `af` is app.tsx's mutable `state.addFriend`; `onPatch`
// mutates it in place and re-renders, same pattern as ExpenseModal's `onPatch`.
import type { AddFriendModel } from '../types.ts';
import { ModalBackdrop } from './Shared.tsx';
import shared from './shared.module.css';

export function FriendModal({
  af,
  onPatch,
  onClose,
  onSave,
}: {
  af: AddFriendModel;
  onPatch: (patch: Partial<AddFriendModel>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
        <h2>Add a friend</h2>
        <input
          className={shared.in}
          style={{ fontSize: '15px' }}
          value={af.name}
          placeholder="Name"
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="kit-btn primary"
            disabled={!af.name.trim()}
            onClick={onSave}
          >
            Add friend
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
