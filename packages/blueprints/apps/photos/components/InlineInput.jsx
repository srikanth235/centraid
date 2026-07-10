// A shared "type a name, Enter to submit, Escape/blur to cancel" input used
// by both the new-album chip (Chips.jsx) and the album rename control
// (AlbumTools.jsx). Uncontrolled (`defaultValue`, not `value`) — it never
// re-renders on keystroke; only Enter/Escape/blur touch app state. The
// ref-based focus/select guard mirrors `mountMedia`'s once-only pattern.
export function InlineInput({
  value = '',
  placeholder,
  label,
  className,
  autoSelect = false,
  onSubmit,
  onCancel,
}) {
  return (
    <input
      type="text"
      className={className}
      defaultValue={value}
      placeholder={placeholder}
      aria-label={label}
      ref={(el) => {
        if (!el || el.dataset.wired) return;
        el.dataset.wired = '1';
        el.focus();
        if (autoSelect) el.select();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel();
          return;
        }
        if (e.key !== 'Enter') return;
        const title = e.currentTarget.value.trim();
        if (!title) {
          onCancel();
          return;
        }
        e.currentTarget.disabled = true;
        onSubmit(title);
      }}
      onBlur={(e) => {
        if (e.currentTarget.disabled) return; // mid-submit — disabling already fired this blur
        onCancel();
      }}
    />
  );
}
