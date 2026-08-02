// Browser lowering of the shared formatter contract. The standalone kit is
// served as source, so it cannot import the package's TypeScript module at
// runtime; keep this adapter behaviorally identical to src/format.ts.

export function formatRelativeTime(value, now = Date.now()) {
  if (value === undefined) return "Recently";
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Recently";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit] ?? "KB"}`;
}
