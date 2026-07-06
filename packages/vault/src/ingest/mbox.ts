// Minimal RFC 4155 MBOX parsing — enough for the mail people actually export
// (Google Takeout, Thunderbird): `From ` separator lines, unfolded headers,
// plain bodies. Attachments and MIME multiparts are NOT decoded — the body is
// kept verbatim (the vault owns the reference text; full MIME is a later
// importer concern).

export interface MboxMessage {
  /** Message-ID header, or a stable hash key when absent. */
  messageId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  /** ISO timestamp (Date header, else the From-line date, else epoch). */
  sentAt: string;
  body: string;
}

/** Unfold RFC 5322 headers: continuation lines start with WSP. */
function splitHeadersBody(raw: string): { headers: Map<string, string>; body: string } {
  const sep = raw.indexOf('\n\n');
  const headerText = (sep >= 0 ? raw.slice(0, sep) : raw).replace(/\r/g, '');
  const body = sep >= 0 ? raw.slice(sep + 2).replace(/\r/g, '') : '';
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of headerText.split('\n')) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body: body.trim() };
}

/** `"Meera Pillai" <meera@example.com>` → name + lowercased address. */
export function parseAddress(raw: string | undefined): {
  name: string | null;
  email: string | null;
} {
  if (!raw) return { name: null, email: null };
  const angled = raw.match(/^(.*?)<([^>]+)>/);
  if (angled) {
    const name = angled[1]?.trim().replace(/^"|"$/g, '') ?? '';
    return { name: name || null, email: (angled[2] ?? '').trim().toLowerCase() || null };
  }
  const bare = raw.trim();
  return bare.includes('@')
    ? { name: null, email: bare.toLowerCase() }
    : { name: bare || null, email: null };
}

function isoDate(raw: string | undefined): string {
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(parsed) ? '1970-01-01T00:00:00.000Z' : new Date(parsed).toISOString();
}

/** Strip Re:/Fwd: chains and case — the thread grouping key. */
export function threadKey(subject: string | null): string {
  return (subject ?? '(no subject)')
    .replace(/^(\s*(re|fwd?|aw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

/** Parse an MBOX file into messages. */
export function parseMbox(text: string): MboxMessage[] {
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current: string[] = [];
  for (const line of lines) {
    if (/^From .*\d{4}/.test(line) || (line.startsWith('From ') && current.length === 0)) {
      if (current.length > 0) chunks.push(current.join('\n'));
      current = [];
      continue;
    }
    // mboxrd quoting: leading `>From ` unescapes one level.
    current.push(line.replace(/^>(>*From )/, '$1'));
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  const messages: MboxMessage[] = [];
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const { headers, body } = splitHeadersBody(chunk);
    if (headers.size === 0) continue;
    const from = parseAddress(headers.get('from'));
    const subject = headers.get('subject') ?? null;
    const sentAt = isoDate(headers.get('date'));
    const messageId =
      headers.get('message-id')?.replace(/[<>]/g, '').trim() ||
      `mbox-${sentAt}-${(subject ?? '').slice(0, 40)}`;
    messages.push({ messageId, subject, fromName: from.name, fromEmail: from.email, sentAt, body });
  }
  return messages;
}
