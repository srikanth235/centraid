export interface AvatarProps {
  /** Display name — drives the deterministic hue and the initials. */
  name: string;
  /** Size as any CSS length (default `2.25rem`). */
  size?: string;
  /** Rounded-square instead of a circle. */
  shape?: 'rounded';
  /** Optional photo URL; when set, replaces the letter fill. */
  src?: string;
}

// Deterministic hue from the name — must match kit.js letterAvatar exactly.
function hueFor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return ((hash % 360) + 360) % 360;
}

function initialsFor(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] || '')
    .join('')
    .toUpperCase();
}

/** A letter avatar — a stable colour + initials derived from a name. */
export function Avatar({ name, size = '2.25rem', shape, src }: AvatarProps) {
  const style = { width: size, height: size, background: `hsl(${hueFor(name)} 45% 42%)` };
  return (
    <span
      className="kit-avatar"
      aria-hidden="true"
      style={style}
      {...(shape ? { 'data-shape': shape } : {})}
    >
      {src ? <img src={src} alt="" /> : initialsFor(name)}
    </span>
  );
}
