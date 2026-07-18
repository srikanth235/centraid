// A shared "type a name, Enter to submit, Escape/blur to cancel" input used
// by both the new-album chip and the album rename control (Sidebar.tsx).
// Uncontrolled (`defaultValue`, not `value`) — it never re-renders on
// keystroke; only Enter/Escape/blur touch app state. The ref-based
// focus/select guard mirrors `mountMedia`'s once-only pattern. Renders only
// kit vocabulary (`kit-input`, `bare`), so it owns no CSS module.
export function InlineInput({
  value = '',
  placeholder,
  label,
  // kit-input is the text-input primitive (app.css no longer styles a bare
  // `input` element) — every caller gets it unless it composes its own
  // (the new-album chip rides `kit-input bare`).
  className = 'kit-input',
  autoSelect = false,
  onSubmit,
  onCancel,
}: {
  value?: string;
  placeholder?: string;
  label?: string;
  className?: string;
  autoSelect?: boolean;
  onSubmit: (title: string) => void;
  onCancel: () => void;
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
