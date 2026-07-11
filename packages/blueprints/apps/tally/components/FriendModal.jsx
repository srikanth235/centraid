// The add-friend form: name + colour picker. `af` is app.jsx's mutable
// `state.addFriend`; `onPatch` mutates it in place and re-renders, same
// pattern as ExpenseModal's `onPatch`.
import { FRIEND_COLORS } from '../format.js';
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
        <div className="s-field">
          <div className="s-flabel">Colour</div>
          <div className="s-catrow">
            {FRIEND_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="kit-chip quiet"
                aria-pressed={String(af.color === c)}
                aria-label="Colour"
                onClick={() => onPatch({ color: c })}
              >
                <span
                  style={{
                    display: 'block',
                    width: '18px',
                    height: '18px',
                    borderRadius: '999px',
                    background: c,
                  }}
                />
              </button>
            ))}
          </div>
        </div>
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
