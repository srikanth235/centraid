export function InlineInput({
  value = "",
  placeholder,
  label,
  className = "kit-input",
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
        el.dataset.wired = "1";
        el.focus();
        if (autoSelect) el.select();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          onCancel();
          return;
        }
        if (e.key !== "Enter") return;
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
