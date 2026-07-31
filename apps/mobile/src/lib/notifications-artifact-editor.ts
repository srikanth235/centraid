export interface EditableArtifactField {
  key: string;
  label: string;
  value: string;
  multiline: boolean;
}

/** Mobile edits only scalar text fields; structured values stay read-only. */
export function editableArtifactFields(
  artifact: Readonly<Record<string, unknown>>
): EditableArtifactField[] {
  return Object.entries(artifact)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => ({
      key,
      label: key
        .replaceAll("_", " ")
        .replace(/\b\w/gu, (letter) => letter.toUpperCase()),
      value,
      multiline:
        key === "body" ||
        key === "text" ||
        key === "description" ||
        value.includes("\n"),
    }));
}

export function applyArtifactEdits(
  artifact: Readonly<Record<string, unknown>>,
  edits: Readonly<Record<string, string>>
): Record<string, unknown> {
  return { ...artifact, ...edits };
}
