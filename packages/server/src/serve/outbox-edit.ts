// Server-side outbox edit support (#308): `outbox.decide` needs the artifact
// and its wire request to replace TOGETHER, so the gateway rebuilds the request
// from an edited artifact, per verb. `rawRfc2822` duplicates the gmail-send
// handler's copy deliberately — mirror any change by hand.

export interface OutboxWireRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export type OutboxRequestRebuilder = (
  original: OutboxWireRequest,
  artifact: Record<string, unknown>
) => OutboxWireRequest;

function normalizeRecipients(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) return [value];
  if (Array.isArray(value)) {
    const strings = value.filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    if (strings.length === value.length && strings.length > 0) return strings;
  }
  return [];
}

function rawRfc2822(to: string[], subject: string, body: string): string {
  const lines = [
    `To: ${to.join(", ")}`,
    `Subject: ${subject || "(no subject)"}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function rebuildGmailSend(
  original: OutboxWireRequest,
  artifact: Record<string, unknown>
): OutboxWireRequest {
  const to = normalizeRecipients(artifact.to);
  if (to.length === 0) {
    throw new Error('gmail.send needs at least one recipient in "to"');
  }
  const subject = typeof artifact.subject === "string" ? artifact.subject : "";
  const body = typeof artifact.body === "string" ? artifact.body : "";
  return {
    ...original,
    body: JSON.stringify({ raw: rawRfc2822(to, subject, body) }),
  };
}

const REBUILDERS: Record<string, OutboxRequestRebuilder> = {
  "gmail.send": rebuildGmailSend,
};

export function outboxVerbIsEditable(verb: string): boolean {
  return Object.hasOwn(REBUILDERS, verb);
}

export function rebuilderForVerb(
  verb: string
): OutboxRequestRebuilder | undefined {
  return REBUILDERS[verb];
}

/** No added/removed fields, no changed kinds; the rest must come back
 *  byte-identical. Throws 400-safe messages. */
export function assertArtifactShapeUnchanged(
  staged: Record<string, unknown>,
  edited: Record<string, unknown>
): void {
  const stagedKeys = Object.keys(staged).sort();
  const editedKeys = Object.keys(edited).sort();
  const sameKeys =
    stagedKeys.length === editedKeys.length &&
    stagedKeys.every((k, i) => k === editedKeys[i]);
  if (!sameKeys) {
    throw new Error(
      `edited artifact must have exactly the staged fields (${stagedKeys.join(", ")}) — fields can't be added or removed`
    );
  }
  for (const key of stagedKeys) {
    const stagedVal = staged[key];
    const editedVal = edited[key];
    if (typeof stagedVal === "string") {
      if (typeof editedVal !== "string") {
        throw new Error(`field "${key}" must stay a string`);
      }
      continue;
    }
    if (Array.isArray(stagedVal)) {
      if (
        !Array.isArray(editedVal) ||
        editedVal.some((v) => typeof v !== "string")
      ) {
        throw new Error(`field "${key}" must stay a list of strings`);
      }
      continue;
    }
    if (JSON.stringify(stagedVal) !== JSON.stringify(editedVal)) {
      throw new Error(
        `field "${key}" isn't editable — it must match the staged value exactly`
      );
    }
  }
}
