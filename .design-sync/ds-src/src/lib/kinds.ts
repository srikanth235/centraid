// Human labels for vault entity kinds — mirrors the kit's PICK_KIND_LABELS.
// Internal helper (not a component); used by ReferenceStrip and MentionChip.
const KIND_LABELS: Record<string, string> = {
  'core.party': 'Person',
  'core.document': 'Document',
  'core.asset': 'File',
  'core.event': 'Event',
  'core.place': 'Place',
  'core.collection': 'Collection',
  'core.message': 'Message',
  'knowledge.note': 'Note',
  'knowledge.annotation': 'Note',
};

/** Map an entity type (e.g. `core.party`) to a human label (`Person`). */
export function entityKindLabel(type: string): string {
  if (KIND_LABELS[type]) return KIND_LABELS[type];
  const seg = type.split('.').pop() || type;
  return seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
