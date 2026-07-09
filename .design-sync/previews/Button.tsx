import { Button } from '@centraid/desktop-shell-ds';

const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };

/** The three weights — `primary` for the page's main action, `soft` for
 *  secondary, `ghost` for tertiary/toolbar actions. */
export function Variants() {
  return (
    <div style={row}>
      <Button label="Create app" variant="primary" />
      <Button label="Import" variant="soft" />
      <Button label="Cancel" variant="ghost" />
    </div>
  );
}

/** A leading icon (any glyph from the shared icon set) sharpens intent. */
export function WithIcon() {
  return (
    <div style={row}>
      <Button label="New app" variant="primary" icon="Plus" />
      <Button label="Search" variant="soft" icon="Search" />
      <Button label="History" variant="ghost" icon="History" />
    </div>
  );
}

/** Disabled state — muted and non-interactive across every variant. */
export function Disabled() {
  return (
    <div style={row}>
      <Button label="Create app" variant="primary" icon="Plus" disabled />
      <Button label="Import" variant="soft" disabled />
      <Button label="Cancel" variant="ghost" disabled />
    </div>
  );
}
