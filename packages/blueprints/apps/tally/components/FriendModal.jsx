// The add-friend form: just a name. A friend's avatar hue is derived from the
// party (issue #441 A3), not chosen and stored per Tally row, so there is no
// colour picker. `af` is app.jsx's mutable `state.addFriend`; `onPatch`
// mutates it in place and re-renders, same pattern as ExpenseModal's `onPatch`.
import { ModalBackdrop } from './Shared.jsx';

export function FriendModal({ af, onPatch, onClose, onSave }) {
  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal" style={{ maxWidth: '400px' }} onClick={(e) => e.stopPropagation()}>
        <h2>Add a friend</h2>
        <input
          className="s-in"
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
