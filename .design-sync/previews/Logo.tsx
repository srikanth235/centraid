import { Logo } from '@centraid/desktop-shell-ds';

/** The Centraid brand mark — three arcs (violet / amber / cyan) around a
 *  rose core dot. Self-contained SVG; no CSS dependency. */
export function Default() {
  return <Logo size={56} />;
}

/** Scales cleanly from a 24px chrome mark to a 64px splash mark. */
export function Sizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22 }}>
      {[24, 32, 48, 64].map((s) => (
        <Logo key={s} size={s} />
      ))}
    </div>
  );
}
