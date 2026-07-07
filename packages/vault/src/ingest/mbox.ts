// Minimal RFC 4155 MBOX parsing — enough for the mail people actually export
// (Google Takeout, Thunderbird): `From ` separator lines, unfolded headers,
// MIME multiparts walked for the text body AND the attachments (issue #296:
// the import spine is the real volume source of blobs — an mbox door that
// drops attachments would re-open the gap the staging band closes).

export interface MboxAttachment {
  filename: string;
  mediaType: string;
  data: Buffer;
}

export interface MboxMessage {
  /** Message-ID header, or a stable hash key when absent. */
  messageId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  /** ISO timestamp (Date header, else the From-line date, else epoch). */
  sentAt: string;
  body: string;
  /** Decoded MIME parts carrying a filename — the email's files. */
  attachments: MboxAttachment[];
}

/** Unfold RFC 5322 headers: continuation lines start with WSP. */
function splitHeadersBody(
  raw: string,
  options: { trim?: boolean } = {},
): { headers: Map<string, string>; body: string } {
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
  return { headers, body: options.trim === false ? body : body.trim() };
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

/** `content-type: multipart/mixed; boundary="b1"` → `b1`, or null. */
function boundaryOf(contentType: string | undefined): string | null {
  const m = contentType?.match(/boundary\s*=\s*"?([^";]+)"?/i);
  return m?.[1] ?? null;
}

/** `filename="tax.pdf"` (content-disposition) or `name=` (content-type). */
function filenameOf(headers: Map<string, string>): string | null {
  const disp = headers.get('content-disposition');
  const ct = headers.get('content-type');
  const m =
    disp?.match(/filename\s*=\s*"?([^";]+)"?/i) ?? ct?.match(/name\s*=\s*"?([^";]+)"?/i) ?? null;
  return m?.[1]?.trim() || null;
}

/** Decode one MIME part body per its content-transfer-encoding. */
function decodePart(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding ?? '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const qp = body
      .replace(/[=]\r?\n/g, '')
      .replace(/[=]([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(qp, 'latin1');
  }
  return Buffer.from(body, 'utf8');
}

interface WalkedMime {
  /** Best text body found (text/plain wins over text/html). */
  text: string | null;
  html: string | null;
  attachments: MboxAttachment[];
}

/** Walk a MIME tree: multiparts recurse, filenames become attachments. */
function walkMime(
  headers: Map<string, string>,
  rawBody: string,
  into: WalkedMime,
  depth = 0,
): void {
  if (depth > 8) return; // hostile nesting stops here
  const contentType = headers.get('content-type') ?? 'text/plain';
  const boundary = boundaryOf(contentType);
  if (contentType.toLowerCase().startsWith('multipart/') && boundary) {
    // Parts sit between `--boundary` markers; the closing `--boundary--`
    // (and any preamble/epilogue) falls away naturally.
    const marker = `--${boundary}`;
    const segments = rawBody.split(new RegExp(`^${escapeRegExp(marker)}(?:--)?[ \\t]*$`, 'm'));
    for (const segment of segments.slice(1)) {
      const part = segment.replace(/^\r?\n/, '');
      if (!part.trim()) continue;
      const parsed = splitHeadersBody(part, { trim: false });
      walkMime(parsed.headers, parsed.body, into, depth + 1);
    }
    return;
  }
  const filename = filenameOf(headers);
  const encoding = headers.get('content-transfer-encoding');
  if (filename) {
    into.attachments.push({
      filename,
      mediaType: contentType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream',
      data: decodePart(rawBody, encoding),
    });
    return;
  }
  const kind = contentType.split(';')[0]?.trim().toLowerCase() ?? 'text/plain';
  if (kind === 'text/plain' && into.text === null) {
    into.text = decodePart(rawBody, encoding).toString('utf8').trim();
  } else if (kind === 'text/html' && into.html === null) {
    into.html = decodePart(rawBody, encoding).toString('utf8').trim();
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    const { headers, body } = splitHeadersBody(chunk, { trim: false });
    if (headers.size === 0) continue;
    const from = parseAddress(headers.get('from'));
    const subject = headers.get('subject') ?? null;
    const sentAt = isoDate(headers.get('date'));
    const messageId =
      headers.get('message-id')?.replace(/[<>]/g, '').trim() ||
      `mbox-${sentAt}-${(subject ?? '').slice(0, 40)}`;
    // Walk the MIME tree: plain body preferred, html as fallback, every
    // filename-bearing part decoded as an attachment.
    const walked: WalkedMime = { text: null, html: null, attachments: [] };
    walkMime(headers, body, walked);
    messages.push({
      messageId,
      subject,
      fromName: from.name,
      fromEmail: from.email,
      sentAt,
      body: walked.text ?? walked.html ?? body.trim(),
      attachments: walked.attachments,
    });
  }
  return messages;
}
