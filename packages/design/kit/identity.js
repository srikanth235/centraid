// Browser lowering of the shared identity contract.  Keep this tiny adapter
// in the standalone kit so custom elements use the same initials rule as the
// TypeScript shell and native clients.
const IDENTITY_COLORS = [
  "#3EC8B4",
  "#4E68DD",
  "#E55772",
  "#7C5BD9",
  "#E89A3C",
  "#5C8A4E",
  "#B47B3F",
  "#5C677D",
];

export function identityInitials(name) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function identityColor(value) {
  const text = String(value ?? "").trim();
  if (!text) return IDENTITY_COLORS[0];
  let hash = 0;
  for (const character of text)
    hash = (hash * 31 + character.codePointAt(0)) | 0;
  return (
    IDENTITY_COLORS[Math.abs(hash) % IDENTITY_COLORS.length] ??
    IDENTITY_COLORS[0]
  );
}
