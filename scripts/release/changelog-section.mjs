export function changelogSectionBody(text, heading) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const re = new RegExp(
    `^##\\s+\\[?${escaped}\\]?[^\\n]*\\n(?<body>[\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "mu"
  );
  const match = text.match(re);
  return match ? (match.groups?.body ?? "") : null;
}
