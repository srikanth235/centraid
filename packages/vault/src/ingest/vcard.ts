// Minimal vCard 3.0/4.0 parsing for ingest customs (§10): FN, N (for
// sort_name), BDAY, EMAIL, TEL. Same stance as ics.ts — a border post, not a
// full implementation; unknown properties pass by untouched.

export interface VcardIdentifier {
  scheme: 'email' | 'tel';
  value: string;
  label: string | null;
}

export interface Vcard {
  fn: string;
  sortName: string | null;
  bday: string | null;
  identifiers: VcardIdentifier[];
}

function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

/** Normalize a handle: lowercase emails, strip separators from tel. */
export function normalizeHandle(scheme: 'email' | 'tel', value: string): string {
  if (scheme === 'email') return value.trim().toLowerCase();
  return value.replace(/[\s().-]/g, '');
}

/** Parse every VCARD in a document. */
export function parseVcards(text: string): Vcard[] {
  const cards: Vcard[] = [];
  let current: Vcard | null = null;
  for (const line of unfold(text)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [rawName, ...paramParts] = left.split(';');
    // Strip vCard 2.1/3.0 grouping prefix (item1.EMAIL).
    const name = (rawName ?? '').replace(/^[^.]+\./, '').toUpperCase();
    const params = paramParts.join(';').toUpperCase();
    if (name === 'BEGIN' && value.toUpperCase() === 'VCARD') {
      current = { fn: '', sortName: null, bday: null, identifiers: [] };
      continue;
    }
    if (name === 'END' && value.toUpperCase() === 'VCARD') {
      if (current?.fn) cards.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    switch (name) {
      case 'FN':
        current.fn = value.trim();
        break;
      case 'N': {
        // Family;Given;… → "Family, Given" collation form.
        const [family, given] = value.split(';');
        if (family || given) current.sortName = [family, given].filter(Boolean).join(', ');
        break;
      }
      case 'BDAY':
        current.bday = value.trim();
        break;
      case 'EMAIL':
        current.identifiers.push({
          scheme: 'email',
          value: normalizeHandle('email', value),
          label: labelFrom(params),
        });
        break;
      case 'TEL':
        current.identifiers.push({
          scheme: 'tel',
          value: normalizeHandle('tel', value),
          label: labelFrom(params),
        });
        break;
      default:
        break;
    }
  }
  return cards;
}

function labelFrom(params: string): string | null {
  for (const label of ['HOME', 'WORK', 'CELL']) {
    if (params.includes(label)) return label.toLowerCase();
  }
  return null;
}
